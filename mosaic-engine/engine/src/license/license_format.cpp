#include "license/license_format.hpp"

#include <cstdio>
#include <cstring>

#include "monocypher-ed25519.h"
#include "monocypher.h"

namespace mosaic::license {

namespace {
const char* kB64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

int b64value(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '-' || c == '+') return 62;
    if (c == '_' || c == '/') return 63;
    return -1;
}

// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm): no time zone involved.
int64_t daysFromCivil(int64_t y, unsigned m, unsigned d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = static_cast<unsigned>(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + static_cast<int64_t>(doe) - 719468;
}
}  // namespace

std::string base64url(const std::string& bytes) {
    std::string out;
    uint32_t acc = 0;
    int bits = 0;
    for (unsigned char c : bytes) {
        acc = (acc << 8) | c;
        bits += 8;
        while (bits >= 6) {
            bits -= 6;
            out += kB64[(acc >> bits) & 63];
        }
    }
    if (bits > 0) out += kB64[(acc << (6 - bits)) & 63];
    return out;
}

std::optional<std::string> unbase64url(const std::string& text) {
    std::string out;
    uint32_t acc = 0;
    int bits = 0;
    for (char c : text) {
        if (c == '=' || c == '\n' || c == '\r' || c == ' ') continue;
        int v = b64value(c);
        if (v < 0) return std::nullopt;
        acc = (acc << 6) | static_cast<uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out += static_cast<char>((acc >> bits) & 0xFF);
        }
    }
    return out;
}

std::string hex(const uint8_t* data, size_t n) {
    static const char* digits = "0123456789abcdef";
    std::string out;
    for (size_t i = 0; i < n; ++i) {
        out += digits[data[i] >> 4];
        out += digits[data[i] & 15];
    }
    return out;
}

std::optional<std::vector<uint8_t>> unhex(const std::string& text) {
    if (text.size() % 2) return std::nullopt;
    std::vector<uint8_t> out;
    for (size_t i = 0; i < text.size(); i += 2) {
        auto nib = [](char c) -> int {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        };
        int hi = nib(text[i]), lo = nib(text[i + 1]);
        if (hi < 0 || lo < 0) return std::nullopt;
        out.push_back(static_cast<uint8_t>(hi * 16 + lo));
    }
    return out;
}

std::string sha512hex(const std::string& text, size_t bytes) {
    uint8_t h[64];
    crypto_sha512(h, reinterpret_cast<const uint8_t*>(text.data()), text.size());
    return hex(h, bytes < 64 ? bytes : 64);
}

std::optional<int64_t> parseTime(const std::string& iso) {
    int y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0;
    char tail = 0;
    if (iso.size() == 10) {
        if (std::sscanf(iso.c_str(), "%4d-%2d-%2d", &y, &mo, &d) != 3) return std::nullopt;
    } else if (std::sscanf(iso.c_str(), "%4d-%2d-%2dT%2d:%2d:%2d%c", &y, &mo, &d, &h, &mi, &s, &tail) != 7 || tail != 'Z') {
        return std::nullopt;
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return std::nullopt;
    return daysFromCivil(y, static_cast<unsigned>(mo), static_cast<unsigned>(d)) * 86400 + h * 3600 + mi * 60 + s;
}

std::string formatTime(int64_t t) {
    int64_t days = t >= 0 ? t / 86400 : (t - 86399) / 86400;
    int64_t secs = t - days * 86400;
    // civil from days (Hinnant)
    int64_t z = days + 719468;
    const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    const unsigned doe = static_cast<unsigned>(z - era * 146097);
    const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    int64_t y = static_cast<int64_t>(yoe) + era * 400;
    const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    const unsigned mp = (5 * doy + 2) / 153;
    const unsigned d = doy - (153 * mp + 2) / 5 + 1;
    const unsigned m = mp < 10 ? mp + 3 : mp - 9;
    y += m <= 2;
    char buf[32];
    std::snprintf(buf, sizeof buf, "%04d-%02u-%02uT%02d:%02d:%02dZ", static_cast<int>(y), m, d,
                  static_cast<int>(secs / 3600), static_cast<int>(secs / 60 % 60), static_cast<int>(secs % 60));
    return buf;
}

PublicKey publicKeyFromSeed(const std::array<uint8_t, 32>& seed) {
    uint8_t s[32], secret[64];
    PublicKey pk{};
    std::memcpy(s, seed.data(), 32);  // key_pair wipes the seed it's given
    crypto_ed25519_key_pair(secret, pk.data(), s);
    crypto_wipe(secret, sizeof secret);
    return pk;
}

std::string signLicense(const std::string& payloadJson, const std::array<uint8_t, 32>& seed) {
    uint8_t s[32], secret[64], pk[32], sig[64];
    std::memcpy(s, seed.data(), 32);
    crypto_ed25519_key_pair(secret, pk, s);
    crypto_ed25519_sign(sig, secret, reinterpret_cast<const uint8_t*>(payloadJson.data()), payloadJson.size());
    crypto_wipe(secret, sizeof secret);
    return json{{"payload", base64url(payloadJson)}, {"sig", base64url(std::string(reinterpret_cast<char*>(sig), 64))}}.dump(2) + "\n";
}

std::optional<json> openLicense(const std::string& fileText, const std::vector<TrustedKey>& keys, std::string& error) {
    json file = json::parse(fileText, nullptr, false);
    if (!file.is_object() || !file.contains("payload") || !file.contains("sig") || !file["payload"].is_string() || !file["sig"].is_string())
        return error = "not a Bluvu license file", std::nullopt;
    auto payloadBytes = unbase64url(file["payload"].get<std::string>());
    auto sig = unbase64url(file["sig"].get<std::string>());
    if (!payloadBytes || !sig || sig->size() != 64) return error = "the license file is damaged", std::nullopt;
    json payload = json::parse(*payloadBytes, nullptr, false);
    if (!payload.is_object()) return error = "the license file is damaged", std::nullopt;
    std::string kid = payload.value("kid", "");
    for (auto& k : keys) {
        if (k.kid != kid) continue;
        if (crypto_ed25519_check(reinterpret_cast<const uint8_t*>(sig->data()), k.key.data(),
                                 reinterpret_cast<const uint8_t*>(payloadBytes->data()), payloadBytes->size()) != 0)
            return error = "the license file's signature doesn't match (changed or not from Blue Arc Networks)", std::nullopt;
        return payload;
    }
    return error = "the license file is signed with a key this version doesn't know (" + (kid.empty() ? std::string("none") : kid) + ")", std::nullopt;
}

std::array<uint8_t, 32> testKeySeed() {
    // SHA-512("bluvu-license-test-key: published, never trust in a venue build"), first 32 bytes.
    // The same seed is in tools/license-test-key.txt.
    const std::string phrase = "bluvu-license-test-key: published, never trust in a venue build";
    uint8_t h[64];
    crypto_sha512(h, reinterpret_cast<const uint8_t*>(phrase.data()), phrase.size());
    std::array<uint8_t, 32> seed{};
    std::memcpy(seed.data(), h, 32);
    return seed;
}

}  // namespace mosaic::license
