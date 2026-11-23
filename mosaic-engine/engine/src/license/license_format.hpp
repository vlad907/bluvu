// The license file format, shared by the engine (which only verifies) and the license tool
// (which also signs, with a key it's given). See docs/LICENSING_PLAN.md.
//
// A license file is JSON: {"payload": "<base64url of the payload's JSON bytes>", "sig": "<base64url
// Ed25519 signature over those exact bytes>"}. Signing the bytes, not re-serialized JSON, means no
// canonical form is needed: the engine parses exactly what was signed.
#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

namespace mosaic::license {

using json = nlohmann::json;
using PublicKey = std::array<uint8_t, 32>;

struct TrustedKey {
    std::string kid;  // the key id a payload names ("kid")
    PublicKey key;
};

std::string base64url(const std::string& bytes);
std::optional<std::string> unbase64url(const std::string& text);  // nullopt on bad input
std::string hex(const uint8_t* data, size_t n);
std::optional<std::vector<uint8_t>> unhex(const std::string& text);

// SHA-512 of text, the first `bytes` bytes, in hex.
std::string sha512hex(const std::string& text, size_t bytes = 16);

// "2027-11-22T00:00:00Z" <-> unix seconds (UTC). Also accepts a date alone ("2027-11-22").
std::optional<int64_t> parseTime(const std::string& iso);
std::string formatTime(int64_t unixSeconds);

// The key a seed makes (Ed25519). The seed is 32 bytes.
PublicKey publicKeyFromSeed(const std::array<uint8_t, 32>& seed);
// Signs the payload JSON text with the key the seed makes: the license file's text.
std::string signLicense(const std::string& payloadJson, const std::array<uint8_t, 32>& seed);

// Opens a license file: checks its signature with the trusted key its payload names. On success
// returns the payload; on failure sets `error` (in words for the editor) and returns nullopt.
std::optional<json> openLicense(const std::string& fileText, const std::vector<TrustedKey>& keys, std::string& error);

// The published test key (tools/license-test-key.txt): anyone can sign with it, so only CI and
// development builds trust it (MOSAIC_LICENSE_TEST_KEY).
std::array<uint8_t, 32> testKeySeed();
constexpr const char* kTestKid = "test";

}  // namespace mosaic::license
