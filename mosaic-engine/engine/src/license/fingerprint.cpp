// This media server's identity for license binding: three identifiers, each hashed (the license
// server and the license file only ever see the hashes). Any two of three must match, so a GPU,
// NIC or disk swap, or a Windows reinstall, keeps the license; a new PC is a move.
#include <algorithm>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "license/license.hpp"

#ifdef _WIN32
#include <windows.h>
#elif defined(__APPLE__)
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <sys/mount.h>
#endif

namespace mosaic::license {

namespace {
std::string hashed(const char* what, const std::string& raw) {
    if (raw.empty()) return "";
    return sha512hex(std::string("bluvu-fp-v1|") + what + "|" + raw, 16);
}

#ifdef _WIN32
std::string narrow(const std::wstring& w) {
    if (w.empty()) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
    std::string s(static_cast<size_t>(n), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), s.data(), n, nullptr, nullptr);
    return s;
}

std::string machineGuid() {
    wchar_t buf[128];
    DWORD size = sizeof buf;
    if (RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Cryptography", L"MachineGuid", RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
                     nullptr, buf, &size) != ERROR_SUCCESS)
        return "";
    return narrow(buf);
}

// The SMBIOS "System Information" (type 1) structure's UUID.
std::string smbiosUuid() {
    UINT size = GetSystemFirmwareTable('RSMB', 0, nullptr, 0);
    if (size < 8) return "";
    std::vector<uint8_t> buf(size);
    if (GetSystemFirmwareTable('RSMB', 0, buf.data(), size) != size) return "";
    uint32_t len = 0;
    std::memcpy(&len, buf.data() + 4, 4);  // RawSMBIOSData: 4 bytes of versions, then the table length
    const uint8_t* p = buf.data() + 8;
    const uint8_t* end = p + std::min<size_t>(len, size - 8);
    while (p + 4 <= end) {
        uint8_t type = p[0], hlen = p[1];
        if (hlen < 4 || p + hlen > end) break;
        if (type == 1 && hlen >= 24) {
            const uint8_t* u = p + 8;
            bool allZero = true, allFF = true;
            for (int i = 0; i < 16; ++i) {
                allZero &= u[i] == 0;
                allFF &= u[i] == 0xFF;
            }
            if (allZero || allFF) return "";  // not set by the board's maker
            return hex(u, 16);
        }
        if (type == 127) break;
        const uint8_t* s = p + hlen;  // the strings after the formatted part end with two zero bytes
        while (s + 1 < end && (s[0] || s[1])) ++s;
        p = s + 2;
    }
    return "";
}

std::string systemDisk() {
    wchar_t dir[MAX_PATH];
    if (!GetWindowsDirectoryW(dir, MAX_PATH)) return "";
    std::wstring root(dir, 3);  // "C:\"
    DWORD serial = 0;
    if (!GetVolumeInformationW(root.c_str(), nullptr, 0, &serial, nullptr, nullptr, nullptr, 0)) return "";
    return std::to_string(serial);
}
#elif defined(__APPLE__)
std::string platformProperty(const char* key) {
    io_service_t dev = IOServiceGetMatchingService(0, IOServiceMatching("IOPlatformExpertDevice"));
    if (!dev) return "";
    std::string out;
    CFStringRef k = CFStringCreateWithCString(nullptr, key, kCFStringEncodingUTF8);
    CFTypeRef v = IORegistryEntryCreateCFProperty(dev, k, kCFAllocatorDefault, 0);
    if (v && CFGetTypeID(v) == CFStringGetTypeID()) {
        char buf[256];
        if (CFStringGetCString(static_cast<CFStringRef>(v), buf, sizeof buf, kCFStringEncodingUTF8)) out = buf;
    }
    if (v) CFRelease(v);
    CFRelease(k);
    IOObjectRelease(dev);
    return out;
}
#endif
}  // namespace

Fingerprint thisMachine() {
#ifdef MOSAIC_LICENSE_TEST_KEY
    // Test builds only: stand in for another PC ("guid,uuid,disk", already hashed).
    if (const char* fake = std::getenv("MOSAIC_LICENSE_FINGERPRINT")) {
        Fingerprint f;
        std::string s = fake;
        std::vector<std::string> parts{""};
        for (char c : s) {
            if (c == ',') parts.emplace_back();
            else parts.back() += c;
        }
        parts.resize(3);
        f.machineGuid = parts[0];
        f.smbiosUuid = parts[1];
        f.systemDisk = parts[2];
        return f;
    }
#endif
    Fingerprint f;
#ifdef _WIN32
    f.machineGuid = hashed("machineGuid", machineGuid());
    f.smbiosUuid = hashed("smbiosUuid", smbiosUuid());
    f.systemDisk = hashed("systemDisk", systemDisk());
#elif defined(__APPLE__)
    // Development Macs: the serial number, the platform UUID and the root volume's id.
    f.machineGuid = hashed("serial", platformProperty("IOPlatformSerialNumber"));
    f.smbiosUuid = hashed("smbiosUuid", platformProperty("IOPlatformUUID"));
    struct statfs st;
    if (statfs("/", &st) == 0) f.systemDisk = hashed("systemDisk", std::to_string(st.f_fsid.val[0]) + ":" + std::to_string(st.f_fsid.val[1]));
#endif
    return f;
}

}  // namespace mosaic::license
