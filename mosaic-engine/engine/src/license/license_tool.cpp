// bluvu_license: makes signing keys, signs license files, reads request codes.
//
//   bluvu_license keygen SEED_FILE              a new signing key (keep SEED_FILE offline; never commit it)
//   bluvu_license pubkey (SEED_FILE | --test)   the public key to build into the engine
//   bluvu_license sign (SEED_FILE | --test) PAYLOAD.json [--request CODE] [--kid KID]
//                                               prints a license file; --request fills "machine"
//                                               from an offline request code, issuedAt defaults to now
//   bluvu_license request CODE                  what an offline request code holds
//   bluvu_license show LICENSE_FILE             a license file's payload (not verified)
//
// --test signs with the published test key: only test builds (MOSAIC_LICENSE_TEST_KEY) accept it.
#include <chrono>
#include <cctype>
#include <cstring>
#include <fstream>
#include <iostream>
#include <random>
#include <sstream>

#include "license/license_format.hpp"

using namespace mosaic::license;

namespace {
std::string readAll(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error("can't read " + path);
    std::stringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

std::array<uint8_t, 32> loadSeed(const std::string& arg) {
    if (arg == "--test") return testKeySeed();
    std::string text = readAll(arg);
    while (!text.empty() && std::isspace(static_cast<unsigned char>(text.back()))) text.pop_back();
    auto bytes = unhex(text);
    if (!bytes || bytes->size() != 32) throw std::runtime_error(arg + " isn't a signing key (64 hex digits)");
    std::array<uint8_t, 32> seed{};
    std::memcpy(seed.data(), bytes->data(), 32);
    return seed;
}

int usage() {
    std::cerr << "usage: bluvu_license keygen SEED_FILE | pubkey (SEED_FILE|--test) | sign (SEED_FILE|--test) PAYLOAD.json [--request CODE] [--kid KID]"
                 " | request CODE | show LICENSE_FILE\n";
    return 2;
}
}  // namespace

int main(int argc, char** argv) {
    try {
        if (argc < 3) return usage();
        std::string cmd = argv[1];
        if (cmd == "keygen") {
            std::random_device rd;  // the OS's random source
            std::array<uint8_t, 32> seed{};
            for (auto& b : seed) b = static_cast<uint8_t>(rd());
            std::ofstream out(argv[2], std::ios::trunc);
            if (!out) throw std::runtime_error(std::string("can't write ") + argv[2]);
            out << hex(seed.data(), 32) << "\n";
            auto pk = publicKeyFromSeed(seed);
            std::cout << "signing key written to " << argv[2] << " (keep it offline, never commit it)\npublic key: " << hex(pk.data(), 32) << "\n";
            return 0;
        }
        if (cmd == "pubkey") {
            auto pk = publicKeyFromSeed(loadSeed(argv[2]));
            std::cout << hex(pk.data(), 32) << "\n";
            return 0;
        }
        if (cmd == "sign") {
            if (argc < 4) return usage();
            auto seed = loadSeed(argv[2]);
            json p = json::parse(readAll(argv[3]));
            for (int i = 4; i + 1 < argc; i += 2) {
                std::string opt = argv[i];
                if (opt == "--request") {
                    auto raw = unbase64url(argv[i + 1]);
                    json r = raw ? json::parse(*raw, nullptr, false) : json();
                    if (!r.is_object() || !r.contains("machine")) throw std::runtime_error("not a request code");
                    p["machine"] = r["machine"];
                } else if (opt == "--kid") {
                    p["kid"] = argv[i + 1];
                } else {
                    return usage();
                }
            }
            if (std::string(argv[2]) == "--test" && !p.contains("kid")) p["kid"] = kTestKid;
            if (!p.contains("v")) p["v"] = 1;
            if (!p.contains("issuedAt"))
                p["issuedAt"] = formatTime(std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count());
            std::cout << signLicense(p.dump(), seed);
            return 0;
        }
        if (cmd == "request") {
            auto raw = unbase64url(argv[2]);
            json r = raw ? json::parse(*raw, nullptr, false) : json();
            if (!r.is_object()) throw std::runtime_error("not a request code");
            std::cout << r.dump(2) << "\n";
            return 0;
        }
        if (cmd == "show") {
            json f = json::parse(readAll(argv[2]));
            auto raw = unbase64url(f.at("payload").get<std::string>());
            if (!raw) throw std::runtime_error("damaged payload");
            std::cout << json::parse(*raw).dump(2) << "\n";
            return 0;
        }
        return usage();
    } catch (const std::exception& e) {
        std::cerr << "bluvu_license: " << e.what() << "\n";
        return 1;
    }
}
