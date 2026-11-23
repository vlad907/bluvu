// Talking to the license server: one JSON POST. Windows uses WinHTTP (HTTPS with the system's
// certificates and proxy settings); other platforms (development Macs) reach a local server over
// plain HTTP with cpp-httplib, which is built here without TLS.
#include <string>

#include "license/license.hpp"

#ifdef _WIN32
#include <windows.h>
#include <winhttp.h>
#else
#include <httplib.h>
#endif

namespace mosaic::license {

#ifdef _WIN32
namespace {
std::wstring widen(const std::string& s) {
    if (s.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring w(static_cast<size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), w.data(), n);
    return w;
}
struct Handle {
    HINTERNET h = nullptr;
    ~Handle() {
        if (h) WinHttpCloseHandle(h);
    }
};
std::string lastError(const char* what) { return std::string(what) + " failed (WinHTTP error " + std::to_string(GetLastError()) + ")"; }
}  // namespace

bool postJson(const std::string& url, const std::string& body, int& status, std::string& response, std::string& error) {
    std::wstring wurl = widen(url);
    URL_COMPONENTS uc{};
    uc.dwStructSize = sizeof uc;
    wchar_t host[256], path[2048];
    uc.lpszHostName = host;
    uc.dwHostNameLength = 256;
    uc.lpszUrlPath = path;
    uc.dwUrlPathLength = 2048;
    if (!WinHttpCrackUrl(wurl.c_str(), 0, 0, &uc)) return error = "bad license server address: " + url, false;
    Handle session{WinHttpOpen(L"Bluvu-Engine/1", WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0)};
    if (!session.h) session.h = WinHttpOpen(L"Bluvu-Engine/1", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session.h) return error = lastError("WinHttpOpen"), false;
    WinHttpSetTimeouts(session.h, 10000, 10000, 15000, 15000);
    Handle connect{WinHttpConnect(session.h, host, uc.nPort, 0)};
    if (!connect.h) return error = lastError("connecting"), false;
    Handle request{WinHttpOpenRequest(connect.h, L"POST", path, nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                      uc.nScheme == INTERNET_SCHEME_HTTPS ? WINHTTP_FLAG_SECURE : 0)};
    if (!request.h) return error = lastError("WinHttpOpenRequest"), false;
    const wchar_t* headers = L"Content-Type: application/json\r\n";
    if (!WinHttpSendRequest(request.h, headers, static_cast<DWORD>(-1L), const_cast<char*>(body.data()), static_cast<DWORD>(body.size()),
                            static_cast<DWORD>(body.size()), 0) ||
        !WinHttpReceiveResponse(request.h, nullptr))
        return error = lastError("sending the request"), false;
    DWORD code = 0, size = sizeof code;
    WinHttpQueryHeaders(request.h, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_HEADER_NAME_BY_INDEX, &code, &size, WINHTTP_NO_HEADER_INDEX);
    status = static_cast<int>(code);
    response.clear();
    for (;;) {
        DWORD avail = 0;
        if (!WinHttpQueryDataAvailable(request.h, &avail) || avail == 0) break;
        std::string chunk(avail, '\0');
        DWORD read = 0;
        if (!WinHttpReadData(request.h, chunk.data(), avail, &read) || read == 0) break;
        response.append(chunk.data(), read);
        if (response.size() > 1 << 20) break;
    }
    return true;
}
#else
bool postJson(const std::string& url, const std::string& body, int& status, std::string& response, std::string& error) {
    if (url.rfind("http://", 0) != 0) return error = "this build reaches the license server over plain HTTP only (development); HTTPS is Windows only", false;
    auto slash = url.find('/', 7);
    std::string origin = slash == std::string::npos ? url : url.substr(0, slash);
    std::string path = slash == std::string::npos ? "/" : url.substr(slash);
    httplib::Client cli(origin);
    cli.set_connection_timeout(10);
    cli.set_read_timeout(15);
    auto res = cli.Post(path, body, "application/json");
    if (!res) return error = "couldn't connect (" + httplib::to_string(res.error()) + ")", false;
    status = res->status;
    response = res->body;
    return true;
}
#endif

}  // namespace mosaic::license
