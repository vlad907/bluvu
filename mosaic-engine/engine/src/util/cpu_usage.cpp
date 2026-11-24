#include "util/cpu_usage.hpp"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <map>
#include <thread>

#if defined(_WIN32)
#include <windows.h>
#include <tlhelp32.h>
#else
#include <pthread.h>
#include <sys/resource.h>
#include <unistd.h>
#endif

namespace mosaic {

#if defined(_WIN32)

namespace {

std::string narrowName(const wchar_t* w) {
    if (!w || !*w) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    if (n <= 1) return "";
    std::string s(static_cast<size_t>(n - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, -1, s.data(), n, nullptr, nullptr);
    return s;
}

uint64_t ticks(const FILETIME& f) { return (static_cast<uint64_t>(f.dwHighDateTime) << 32) | f.dwLowDateTime; }

using GetDescription = HRESULT(WINAPI*)(HANDLE, PWSTR*);
using SetDescription = HRESULT(WINAPI*)(HANDLE, PCWSTR);
using QueryThread = LONG(WINAPI*)(HANDLE, int, void*, ULONG, ULONG*);

FARPROC kernelFn(const char* name) {
    for (const wchar_t* dll : {L"KernelBase.dll", L"kernel32.dll"})
        if (HMODULE m = GetModuleHandleW(dll))
            if (FARPROC f = GetProcAddress(m, name)) return f;
    return nullptr;
}

struct ThreadSample {
    uint64_t busy = 0;  // kernel + user time, 100 ns units
    std::string label;
};

// The DLL (or exe) a thread started in: tells NDI's threads from Media Foundation's and ours.
std::string startModule(HANDLE thread) {
    static const auto query = reinterpret_cast<QueryThread>(reinterpret_cast<void*>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationThread")));
    void* start = nullptr;
    if (!query || query(thread, 9 /* ThreadQuerySetWin32StartAddress */, &start, sizeof start, nullptr) != 0 || !start) return "";
    HMODULE mod = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, static_cast<LPCWSTR>(start), &mod) || !mod) return "";
    wchar_t path[MAX_PATH] = {};
    if (!GetModuleFileNameW(mod, path, MAX_PATH)) return "";
    std::string s = narrowName(path);
    auto slash = s.find_last_of("\\/");
    return slash == std::string::npos ? s : s.substr(slash + 1);
}

std::map<DWORD, ThreadSample> sampleThreads() {
    std::map<DWORD, ThreadSample> out;
    static const auto describe = reinterpret_cast<GetDescription>(reinterpret_cast<void*>(kernelFn("GetThreadDescription")));
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snap == INVALID_HANDLE_VALUE) return out;
    const DWORD pid = GetCurrentProcessId();
    THREADENTRY32 te{};
    te.dwSize = sizeof te;
    for (BOOL ok = Thread32First(snap, &te); ok; ok = Thread32Next(snap, &te)) {
        if (te.th32OwnerProcessID != pid) continue;
        HANDLE h = OpenThread(THREAD_QUERY_INFORMATION, FALSE, te.th32ThreadID);
        if (!h) continue;
        FILETIME created, exited, kernel, user;
        if (GetThreadTimes(h, &created, &exited, &kernel, &user)) {
            ThreadSample s;
            s.busy = ticks(kernel) + ticks(user);
            PWSTR name = nullptr;
            if (describe && SUCCEEDED(describe(h, &name)) && name) {
                s.label = narrowName(name);
                LocalFree(name);
            }
            if (s.label.empty()) {
                std::string mod = startModule(h);
                s.label = "(" + (mod.empty() ? std::string("unknown") : mod) + ")";
            }
            out[te.th32ThreadID] = std::move(s);
        }
        CloseHandle(h);
    }
    CloseHandle(snap);
    return out;
}

uint64_t machineBusy(uint64_t& total) {
    FILETIME idle, kernel, user;
    if (!GetSystemTimes(&idle, &kernel, &user)) return total = 0;
    total = ticks(kernel) + ticks(user);  // kernel time includes idle
    return total - ticks(idle);
}

}  // namespace

void nameThread(const std::string& name) {
    static const auto set = reinterpret_cast<SetDescription>(reinterpret_cast<void*>(kernelFn("SetThreadDescription")));
    if (!set) return;
    std::wstring w(name.begin(), name.end());  // names are ASCII
    set(GetCurrentThread(), w.c_str());
}

CpuUsage measureCpu(int ms) {
    CpuUsage u;
    SYSTEM_INFO si{};
    GetSystemInfo(&si);
    u.cores = std::max<int>(1, static_cast<int>(GetActiveProcessorCount(ALL_PROCESSOR_GROUPS)));
    uint64_t total0 = 0, total1 = 0;
    const uint64_t busy0 = machineBusy(total0);
    const auto t0 = std::chrono::steady_clock::now();
    auto before = sampleThreads();
    std::this_thread::sleep_for(std::chrono::milliseconds(ms));
    auto after = sampleThreads();
    const double window = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    const uint64_t busy1 = machineBusy(total1);
    if (total1 > total0) u.machinePercent = 100.0 * static_cast<double>(busy1 - busy0) / static_cast<double>(total1 - total0);

    std::map<std::string, CpuGroup> groups;
    double sum = 0.0;
    for (auto& [tid, s] : after) {
        auto it = before.find(tid);
        const uint64_t was = it == before.end() ? 0 : it->second.busy;  // a thread born inside the window
        const double pct = s.busy > was && window > 0 ? static_cast<double>(s.busy - was) / 1e7 / window * 100.0 : 0.0;
        CpuGroup& g = groups[s.label];
        g.name = s.label;
        g.threads++;
        g.percent += pct;
        sum += pct;
    }
    u.enginePercent = sum / u.cores;
    for (auto& [name, g] : groups) u.groups.push_back(g);
    std::sort(u.groups.begin(), u.groups.end(), [](const CpuGroup& a, const CpuGroup& b) { return a.percent > b.percent; });
    return u;
}

#else

void nameThread(const std::string& name) {
#if defined(__APPLE__)
    pthread_setname_np(name.substr(0, 63).c_str());
#else
    pthread_setname_np(pthread_self(), name.substr(0, 15).c_str());
#endif
}

// Off Windows: the process total only (development machines; the media server runs Windows).
CpuUsage measureCpu(int ms) {
    auto busy = [] {
        rusage r{};
        getrusage(RUSAGE_SELF, &r);
        return static_cast<double>(r.ru_utime.tv_sec + r.ru_stime.tv_sec) + static_cast<double>(r.ru_utime.tv_usec + r.ru_stime.tv_usec) / 1e6;
    };
    CpuUsage u;
    u.cores = std::max(1, static_cast<int>(sysconf(_SC_NPROCESSORS_ONLN)));
    const auto t0 = std::chrono::steady_clock::now();
    const double b0 = busy();
    std::this_thread::sleep_for(std::chrono::milliseconds(ms));
    const double window = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    if (window > 0) u.enginePercent = (busy() - b0) / window * 100.0 / u.cores;
    return u;
}

#endif

}  // namespace mosaic
