// mosaic_engine --license-self-test: the license rules, without starting an engine.
// Runs in every build (it signs with its own throwaway key, not the test key).
#include <iostream>

#include "core/layout.hpp"
#include "license/license.hpp"

namespace mosaic::license {

namespace {
int failures = 0;
void check(bool ok, const std::string& what) {
    std::cout << (ok ? "  ok   " : "  FAIL ") << what << "\n";
    if (!ok) failures++;
}

std::array<uint8_t, 32> seedOf(uint8_t b) {
    std::array<uint8_t, 32> s{};
    s.fill(b);
    return s;
}

const Fingerprint kHere{"aaaa", "bbbb", "cccc"};
const int64_t kNow = *parseTime("2027-06-01T12:00:00Z");

json payload(const std::string& expires, json extra = json::object()) {
    json p = {{"v", 1}, {"kid", "k1"}, {"licenseId", "lic_test"}, {"customer", "Test"}, {"plan", "starter"},
              {"maxScreens", 8}, {"features", json::array()}, {"issuedAt", "2027-01-01T00:00:00Z"},
              {"expires", expires.empty() ? json(nullptr) : json(expires)}, {"graceDays", 30}, {"machine", kHere.toJson()}};
    for (auto& [k, v] : extra.items()) p[k] = v;
    return p;
}

Layout layoutWith(int outputs, int enabledOutputs = -1) {
    Layout l;
    l.id = "l";
    for (int i = 0; i < outputs; ++i) {
        OutputConfig o;
        o.id = "o" + std::to_string(i);
        o.enabled = enabledOutputs < 0 || i < enabledOutputs;
        l.outputs.push_back(o);
    }
    return l;
}
}  // namespace

int selfTest() {
    const auto seed = seedOf(7);
    const std::vector<TrustedKey> keys{{"k1", publicKeyFromSeed(seed)}};
    auto eval = [&](const json& p, const Fingerprint& fp = kHere, int64_t now = kNow, int64_t lastSeen = 0) {
        return evaluate(signLicense(p.dump(), seed), keys, fp, now, lastSeen);
    };

    std::cout << "license files:\n";
    {
        auto s = eval(payload("2027-11-22T00:00:00Z"));
        check(s.state == "valid" && s.maxScreens == 8 && s.plan == "starter", "a good license is valid (got " + s.state + " " + s.reason + ")");
        check(!s.locked(), "a valid license locks nothing");
    }
    {
        auto s = evaluate("", keys, kHere, kNow, 0);
        check(s.state == "none" && s.locked(), "no license file: none, setup locked");
        s = evaluate("{not json", keys, kHere, kNow, 0);
        check(s.state == "invalid" && s.locked(), "garbage: invalid (" + s.reason + ")");
    }
    {
        std::string text = signLicense(payload("2027-11-22T00:00:00Z").dump(), seed);
        json file = json::parse(text);
        json p = json::parse(*unbase64url(file["payload"].get<std::string>()));
        p["maxScreens"] = 999;  // tampered: more screens, same signature
        file["payload"] = base64url(p.dump());
        auto s = evaluate(file.dump(), keys, kHere, kNow, 0);
        check(s.state == "invalid" && s.maxScreens == 0, "tampered payload: invalid (" + s.reason + ")");
        file = json::parse(text);
        std::string sig = *unbase64url(file["sig"].get<std::string>());
        sig[5] ^= 1;
        file["sig"] = base64url(sig);
        check(evaluate(file.dump(), keys, kHere, kNow, 0).state == "invalid", "tampered signature: invalid");
    }
    {
        auto other = seedOf(9);
        auto s = evaluate(signLicense(payload("2027-11-22T00:00:00Z").dump(), other), keys, kHere, kNow, 0);
        check(s.state == "invalid", "signed with an unknown key: invalid (" + s.reason + ")");
        s = eval(payload("2027-11-22T00:00:00Z", {{"kid", "nope"}}));
        check(s.state == "invalid", "names a key this build doesn't have: invalid");
        s = eval(payload("2027-11-22T00:00:00Z", {{"v", 2}}));
        check(s.state == "invalid", "a newer format: invalid");
    }

    std::cout << "expiry and grace:\n";
    {
        check(eval(payload("2027-06-20T00:00:00Z")).state == "expiring", "within 30 days of expiry: expiring");
        auto s = eval(payload("2027-05-20T00:00:00Z"));
        check(s.state == "grace" && !s.locked() && s.daysLeft > 0 && s.daysLeft <= 30, "past expiry, within 30 days: grace, nothing locked (" + std::to_string(s.daysLeft) + " days left)");
        s = eval(payload("2027-04-20T00:00:00Z"));
        check(s.state == "expired" && s.locked(), "past the grace period: expired, setup locked");
        check(s.maxScreens == 8, "an expired license still knows its plan");
        s = eval(payload("2027-04-20T00:00:00Z", {{"graceDays", 60}}));
        check(s.state == "grace", "a longer grace in the file is honoured");
        s = eval(payload("", {{"plan", "comp"}, {"maxScreens", -1}}));
        check(s.state == "valid" && s.expires == 0 && s.maxScreens == -1, "a comp license with no expiry is valid for good");
        s = eval(payload("2027-06-10T00:00:00Z", {{"trial", true}, {"graceDays", 0}}));
        check(s.state == "trial", "a running trial: trial");
        s = eval(payload("2027-05-30T00:00:00Z", {{"trial", true}, {"graceDays", 0}}));
        check(s.state == "expired" && s.locked(), "an ended trial: expired");
        s = eval(payload("not a date"));
        check(s.state == "invalid", "a bad expiry: invalid");
    }

    std::cout << "machine binding:\n";
    {
        check(eval(payload("2027-11-22T00:00:00Z"), {"aaaa", "bbbb", "zzzz"}).state == "valid", "2 of 3 identifiers match (new disk): valid");
        check(eval(payload("2027-11-22T00:00:00Z"), {"zzzz", "bbbb", "cccc"}).state == "valid", "2 of 3 match (Windows reinstalled): valid");
        auto s = eval(payload("2027-11-22T00:00:00Z"), {"aaaa", "yyyy", "zzzz"});
        check(s.state == "invalid", "1 of 3 matches (another PC): invalid (" + s.reason + ")");
        check(eval(payload("2027-11-22T00:00:00Z"), {"", "", ""}).state == "invalid", "identifiers unreadable: invalid");
        check(eval(payload("2027-11-22T00:00:00Z", {{"machine", {{"machineGuid", "aaaa"}}}}), {"aaaa", "", ""}).state == "valid",
              "a license with one identifier: that one must match");
    }

    std::cout << "clock set back:\n";
    {
        check(eval(payload("2027-11-22T00:00:00Z"), kHere, kNow, kNow + 86400).state == "valid", "a day behind the last time seen: still valid");
        auto s = eval(payload("2027-11-22T00:00:00Z"), kHere, kNow, kNow + 10 * 86400);
        check(s.state == "invalid" && s.locked(), "10 days behind the last time seen: invalid (" + s.reason + ")");
        s = eval(payload("2027-04-20T00:00:00Z"), kHere, *parseTime("2026-12-01T00:00:00Z"), 0);
        check(s.state == "invalid", "set back before the license was issued (to dodge expiry): invalid");
    }

    std::cout << "screens:\n";
    {
        Layout l = layoutWith(5, 4);
        check(usageOf({&l}).screens == 4, "enabled outputs count, disabled ones don't");
        Endpoint e;
        e.id = "pc";
        for (int part = 1; part <= 4; ++part) {
            EndpointDisplay d;
            d.output = "o0";
            d.partCols = d.partRows = 2;
            d.part = part;
            e.displays.push_back(d);
        }
        l.endpoints.push_back(e);
        check(usageOf({&l}).screens == 7, "a 2x2 cut from one output counts 4 (4 + 3 = 7)");
        l.endpoints[0].displays.push_back(l.endpoints[0].displays[0]);
        check(usageOf({&l}).screens == 7, "the same cell mirrored counts once");
        Layout m = layoutWith(2);
        check(usageOf({&l, &m}).screens == 9 && usageOf({&l, &m}).canvases == 2, "screens add up across canvases");
    }

    std::cout << "limits:\n";
    {
        Status starter = eval(payload("2027-11-22T00:00:00Z"));
        Usage at8{8, 1, 0, 0}, at9{9, 1, 0, 0}, at7{7, 1, 0, 0}, at12{12, 1, 0, 0}, at11{11, 1, 0, 0};
        auto r = changeRefusal(starter, at8, at9);
        check(r.find("Starter allows 8 screens; this would be 9") != std::string::npos, "the 9th screen on Starter is refused: " + r);
        check(changeRefusal(starter, at7, at8).empty(), "up to 8 is fine");
        check(changeRefusal(starter, at12, at11).empty(), "over the limit (after a downgrade): removing is fine");
        check(changeRefusal(starter, at12, at12).empty(), "over the limit: changes that add nothing are fine");
        check(!changeRefusal(starter, Usage{2, 1, 0, 0}, Usage{2, 2, 0, 0}).empty(), "a second wall needs Venue");
        check(!changeRefusal(starter, Usage{2, 1, 0, 0}, Usage{2, 1, 1, 0}).empty(), "a sound zone needs Venue");
        check(!changeRefusal(starter, Usage{2, 1, 0, 0}, Usage{2, 1, 0, 1}).empty(), "a capture card needs Venue");
        Status venue = eval(payload("2027-11-22T00:00:00Z", {{"plan", "venue"}, {"maxScreens", 32}, {"features", {"multiCanvas", "audio", "capture"}}}));
        check(changeRefusal(venue, Usage{20, 1, 0, 0}, Usage{24, 3, 2, 1}).empty(), "Venue: 24 screens, 3 walls, sound and capture are fine");
        check(!changeRefusal(venue, Usage{32, 1, 0, 0}, Usage{33, 1, 0, 0}).empty(), "Venue: the 33rd screen is refused");
        Status unlimited = eval(payload("", {{"plan", "enterprise"}, {"maxScreens", -1}}));
        check(changeRefusal(unlimited, Usage{200, 1, 0, 0}, Usage{300, 1, 0, 0}).empty(), "Enterprise: unlimited");
        Status expired = eval(payload("2027-04-20T00:00:00Z"));
        check(!changeRefusal(expired, at7, at8).empty(), "expired: no screens added");
        check(changeRefusal(expired, at8, at7).empty(), "expired: taking screens away is fine");
    }

    std::cout << "what a request is:\n";
    {
        check(classify("GET", "/api/outputs", "") == Kind::Read, "GET: read");
        check(classify("POST", "/api/walls/main/presets/p1/recall", "") == Kind::Operation, "recall a preset: operation");
        check(classify("POST", "/api/walls/main/show", R"({"ndiName":"A"})") == Kind::Operation, "show a stream: operation");
        check(classify("POST", "/api/scenes/s1/recall", "") == Kind::Operation, "recall a scene: operation");
        check(classify("POST", "/api/walls/main/slots/2", "") == Kind::Operation, "change a slot: operation");
        check(classify("POST", "/api/endpoints/pc1/displays/2/blank", "") == Kind::Operation, "blank a screen: operation");
        check(classify("POST", "/api/layouts/night/activate", "") == Kind::Operation, "switch layout: operation");
        check(classify("PATCH", "/api/sources/v1", R"({"playing":false})") == Kind::Operation, "pause a video: operation");
        check(classify("PATCH", "/api/sources/v1", R"({"playing":false,"rect":{}})") == Kind::Setup, "move a source: setup");
        check(classify("PUT", "/api/layout", R"({"audioOutputs":[]})") == Kind::Operation, "sound output volume: operation");
        check(classify("PUT", "/api/layout", R"({"outputs":[]})") == Kind::Setup, "replace the layout: setup");
        check(classify("PATCH", "/api/outputs/o1", "{}") == Kind::Setup, "change an output: setup");
        check(classify("POST", "/api/walls/main/presets", "{}") == Kind::Setup, "save a preset: setup");
        check(classify("POST", "/api/system/update", "{}") == Kind::Update, "update: update");
        check(classify("PUT", "/api/license", "{}") == Kind::Always, "install a license: always");
        check(classify("POST", "/api/endpoints/checkin", "{}") == Kind::Always, "receiver check-in: always");
        check(classify("PUT", "/api/security", "{}") == Kind::Always, "the PIN: always");
    }

    std::cout << "format:\n";
    {
        check(formatTime(*parseTime("2027-11-22T13:04:05Z")) == "2027-11-22T13:04:05Z", "times round-trip");
        check(*parseTime("2028-03-01") - *parseTime("2028-02-28") == 2 * 86400, "leap years");
        check(unbase64url(base64url(std::string("\x00\xff\x10 any bytes", 13))) == std::string("\x00\xff\x10 any bytes", 13), "base64url round-trips");
    }

    std::cout << (failures ? "FAILED: " + std::to_string(failures) + "\n" : "license self-test passed\n");
    return failures ? 1 : 0;
}

}  // namespace mosaic::license
