#include "license/license.hpp"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <fstream>
#include <iostream>
#include <regex>
#include <set>
#include <cstdlib>
#include <sstream>

#include "core/layout.hpp"

namespace mosaic::license {

namespace fs = std::filesystem;

namespace {
constexpr int64_t kDay = 86400;
constexpr int64_t kExpiringDays = 30;   // the quiet banner starts this long before expiry
constexpr int64_t kClockSlack = 2 * kDay;
// The website (the domain isn't chosen yet: docs/LICENSING_PLAN.md). Buy, renew, account, and the
// offline activation page that turns a request code into a license file.
constexpr const char* kSite = "https://bluvu.example";
constexpr const char* kServer = "https://license.bluvu.example";

int64_t nowSeconds() {
    return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string readFile(const fs::path& p) {
    std::ifstream in(p, std::ios::binary);
    std::stringstream ss;
    ss << in.rdbuf();
    return ss.str();
}

bool writeFileAtomic(const fs::path& p, const std::string& data) {
    std::error_code ec;
    fs::create_directories(p.parent_path(), ec);
    auto tmp = p;
    tmp += ".tmp";
    {
        std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
        out << data;
        if (!out) return false;
    }
    fs::rename(tmp, p, ec);
    return !ec;
}

std::string planName(const std::string& plan) {
    if (plan.empty()) return "This license";
    std::string n = plan;
    n[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(n[0])));
    return n;
}

std::string lockedMessage(const Status& s) {
    const std::string keepsPlaying = "The walls keep playing";
    if (s.state == "expired")
        return "The license ran out on " + formatTime(s.expires).substr(0, 10) + ". " + keepsPlaying +
               "; changing the setup is paused until it's renewed (Settings → License).";
    if (s.state == "invalid")
        return "The license can't be used: " + s.reason + ". " + keepsPlaying + "; to change the setup, fix it in Settings → License.";
    return "No license on this media server. " + keepsPlaying + "; to change the setup, activate a license or a trial in Settings → License.";
}
}  // namespace

Fingerprint Fingerprint::fromJson(const json& j) {
    Fingerprint f;
    if (!j.is_object()) return f;
    f.machineGuid = j.value("machineGuid", "");
    f.smbiosUuid = j.value("smbiosUuid", "");
    f.systemDisk = j.value("systemDisk", "");
    return f;
}

bool sameMachine(const Fingerprint& lic, const Fingerprint& here) {
    int have = 0, match = 0;
    auto one = [&](const std::string& a, const std::string& b) {
        if (a.empty()) return;
        have++;
        if (a == b) match++;
    };
    one(lic.machineGuid, here.machineGuid);
    one(lic.smbiosUuid, here.smbiosUuid);
    one(lic.systemDisk, here.systemDisk);
    return have > 0 && match >= std::min(2, have);
}

bool Status::has(const std::string& feature) const {
    return std::find(features.begin(), features.end(), feature) != features.end();
}

Usage usageOf(const std::vector<const Layout*>& running) {
    Usage u;
    for (const Layout* l : running) {
        if (!l) continue;
        u.canvases++;
        for (auto& o : l->outputs) {
            if (!o.enabled) continue;
            // An output cut into cells on receiving PCs: each distinct cell shown is a screen. The
            // same cell (or the whole picture) mirrored on several screens counts once.
            std::set<int> cells;
            for (auto& e : l->endpoints)
                for (auto& d : e.displays)
                    if (d.output == o.id && d.part > 0 && d.partCols * d.partRows > 1) cells.insert(d.part);
            u.screens += std::max<int>(1, static_cast<int>(cells.size()));
        }
        for (auto& a : l->audioOutputs)
            if (a.enabled) u.audioOutputs++;
        for (auto& s : l->sources)
            if (s.type == SourceType::Capture && s.enabled) u.captureSources++;
    }
    return u;
}

Status evaluate(const std::string& fileText, const std::vector<TrustedKey>& keys, const Fingerprint& here, int64_t now, int64_t lastSeen) {
    Status s;
    auto invalid = [&](const std::string& why) {
        s = Status{};
        s.state = "invalid";
        s.reason = why;
        return s;
    };
    try {
        bool blank = std::all_of(fileText.begin(), fileText.end(), [](char c) { return std::isspace(static_cast<unsigned char>(c)); });
        if (blank) {
            s.reason = "no license installed";
            return s;
        }
        std::string error;
        auto payload = openLicense(fileText, keys, error);
        if (!payload) return invalid(error);
        const json& p = *payload;
        if (p.value("v", 0) != 1) return invalid("the license file is a newer format: update Bluvu");
        if (!sameMachine(Fingerprint::fromJson(p.value("machine", json::object())), here))
            return invalid("it belongs to another media server (move it to this one from your account)");
        auto issued = parseTime(p.value("issuedAt", ""));
        if (!issued) return invalid("the license file is damaged (no issue date)");
        if (now < *issued - kDay || now + kClockSlack < lastSeen)
            return invalid("this PC's clock is set earlier than it was: set the right date and time");

        s.payload = p;
        s.plan = p.value("plan", "");
        s.maxScreens = p.value("maxScreens", 0);
        if (p.contains("features") && p["features"].is_array())
            for (auto& f : p["features"])
                if (f.is_string()) s.features.push_back(f.get<std::string>());
        bool trial = p.value("trial", false);
        if (p.contains("expires") && p["expires"].is_string()) {
            auto exp = parseTime(p["expires"].get<std::string>());
            if (!exp) return invalid("the license file is damaged (bad expiry date)");
            s.expires = *exp;
            s.graceUntil = s.expires + std::max<int64_t>(0, p.value("graceDays", 30)) * kDay;
        } else if (p.contains("expires") && !p["expires"].is_null()) {
            return invalid("the license file is damaged (bad expiry date)");
        }
        auto daysTo = [&](int64_t t) { return t > now ? (t - now + kDay - 1) / kDay : 0; };
        if (s.expires == 0) {
            s.state = trial ? "trial" : "valid";  // perpetual (a comp license)
        } else if (now < s.expires) {
            s.daysLeft = daysTo(s.expires);
            s.state = trial ? "trial" : (s.expires - now <= kExpiringDays * kDay ? "expiring" : "valid");
        } else if (now < s.graceUntil) {
            s.state = "grace";
            s.daysLeft = daysTo(s.graceUntil);
        } else {
            s.state = "expired";
            s.reason = trial ? "the trial has ended" : "the license ran out";
        }
        return s;
    } catch (const std::exception& e) {
        return invalid(std::string("couldn't check the license (") + e.what() + ")");
    }
}

Kind classify(const std::string& method, const std::string& path, const std::string& body) {
    if (method == "GET" || method == "HEAD" || method == "OPTIONS") return Kind::Read;
    if (path.rfind("/api/", 0) != 0) return Kind::Always;
    if (path == "/api/license" || path.rfind("/api/license/", 0) == 0 || path == "/api/security" ||
        path.rfind("/api/security/", 0) == 0 || path == "/api/endpoints/checkin")
        return Kind::Always;
    if (path == "/api/system/update") return Kind::Update;

    // Day-to-day control (docs/CONTROL_API.md, "Quick reference"): used at showtime, never locked.
    static const std::regex operation(
        R"(^/api/(walls/[^/]+/presets/[^/]+/recall|walls/[^/]+/(show|arrange|content|clear|restart)|walls/[^/]+/slots/[0-9]+|)"
        R"(background|scenes/[^/]+/recall|layouts/[^/]+/activate|sources/[^/]+/restart|endpoints/[^/]+/(identify|blank)|)"
        R"(endpoints/[^/]+/displays/[0-9]+/blank|canvases/[^/]+/simulate-gpu-loss)$)");
    if (method == "POST" && std::regex_match(path, operation)) return Kind::Operation;

    // Pausing / playing a video, and a sound output's volume, source or mute: control too.
    auto onlyKeys = [&](std::initializer_list<const char*> allowed) {
        json b = json::parse(body.empty() ? "{}" : body, nullptr, false);
        if (!b.is_object() || b.empty()) return false;
        for (auto& [k, v] : b.items())
            if (std::none_of(allowed.begin(), allowed.end(), [&](const char* a) { return k == a; })) return false;
        return true;
    };
    static const std::regex source(R"(^/api/sources/[^/]+$)");
    if (method == "PATCH" && std::regex_match(path, source) && onlyKeys({"playing"})) return Kind::Operation;
    if (method == "PUT" && path == "/api/layout" && onlyKeys({"audioOutputs"})) return Kind::Operation;
    return Kind::Setup;
}

std::string changeRefusal(const Status& s, const Usage& before, const Usage& after) {
    bool locked = s.locked();
    if (after.screens > before.screens) {
        if (locked) return lockedMessage(s) + " (This would add screens: " + std::to_string(before.screens) + " → " + std::to_string(after.screens) + ".)";
        if (s.maxScreens >= 0 && after.screens > s.maxScreens)
            return planName(s.plan) + " allows " + std::to_string(s.maxScreens) + " screens; this would be " + std::to_string(after.screens) +
                   ". Upgrade in Settings → License.";
    }
    auto feature = [&](int b, int a, int free, const char* name, const std::string& what) -> std::string {
        if (a <= b || a <= free) return "";
        if (locked) return lockedMessage(s);
        if (!s.has(name)) return what + " need the Venue plan. Upgrade in Settings → License.";
        return "";
    };
    if (auto r = feature(before.canvases, after.canvases, 1, "multiCanvas", "Several walls on one server"); !r.empty()) return r;
    if (auto r = feature(before.audioOutputs, after.audioOutputs, 0, "audio", "Sound zones"); !r.empty()) return r;
    if (auto r = feature(before.captureSources, after.captureSources, 0, "capture", "Capture cards"); !r.empty()) return r;
    return "";
}

std::vector<TrustedKey> trustedKeys() {
    std::vector<TrustedKey> keys;
    // Production keys go here (phase 3: generated on the license server; you keep the offline
    // backup of the private half). Until then only test-key builds can verify any license.
#ifdef MOSAIC_LICENSE_TEST_KEY
    keys.push_back({kTestKid, publicKeyFromSeed(testKeySeed())});
#endif
    return keys;
}

Manager::Manager(fs::path dataDir, bool enforce)
    : file_(dataDir / "license.json"), stateFile_(dataDir / "license-state.json"), enforce_(enforce), keys_(trustedKeys()), here_(thisMachine()) {
    json st = json::parse(readFile(stateFile_), nullptr, false);
    if (st.is_object()) lastSeen_ = st.value("lastSeen", int64_t{0});
    lastSaved_ = lastSeen_;
    const char* server = std::getenv("MOSAIC_LICENSE_SERVER");  // its files still need our signature
    server_ = server && *server ? server : kServer;
    while (!server_.empty() && server_.back() == '/') server_.pop_back();
    auto s = status();
    std::cerr << "[license] " << s.state << (s.plan.empty() ? "" : " (" + s.plan + ")") << (s.reason.empty() ? "" : ": " + s.reason)
              << (enforce_ ? "" : "; report-only, nothing is refused") << "\n";
    refresher_ = std::thread([this] { refreshLoop(); });
}

Manager::~Manager() {
    {
        std::lock_guard lock(stopMutex_);
        stopping_ = true;
    }
    stopCv_.notify_all();
    if (refresher_.joinable()) refresher_.join();
}

json Manager::call(const std::string& path, const json& body, int& status, std::string& error) {
    json b = body;
    b["machine"] = here_.toJson();
#ifdef MOSAIC_VERSION
    b["engine"] = MOSAIC_VERSION;
#endif
    std::string response, why;
    status = 0;
    if (!postJson(server_ + path, b.dump(), status, response, why)) {
        error = "couldn't reach the license server (" + why + "). For a media server without internet, use Get request code";
        return nullptr;
    }
    json r = json::parse(response, nullptr, false);
    if (!r.is_object()) {
        error = "the license server sent an answer this version doesn't understand (HTTP " + std::to_string(status) + ")";
        return nullptr;
    }
    if (status != 200) error = r.value("error", "the license server said no (HTTP " + std::to_string(status) + ")");
    return r;
}

std::string Manager::activateOnline(const std::string& key) {
    std::lock_guard serial(refreshMutex_);
    int status = 0;
    std::string error;
    json r = call("/v1/activate", {{"key", key}}, status, error);
    if (!error.empty()) return error;
    return install(r.value("license", ""));
}

std::string Manager::startTrial(const std::string& email) {
    std::lock_guard serial(refreshMutex_);
    int status = 0;
    std::string error;
    json r = call("/v1/trial", {{"email", email}}, status, error);
    if (!error.empty()) return error;
    return install(r.value("license", ""));
}

std::string Manager::refreshNow() {
    std::lock_guard serial(refreshMutex_);
    Status s = status();
    std::string licenseId = s.payload.is_object() ? s.payload.value("licenseId", "") : "";
    auto record = [&](bool ok, const std::string& message) {
        std::lock_guard lock(mutex_);
        lastRefresh_ = {{"time", formatTime(nowSeconds())}, {"ok", ok}, {"message", message}};
        if (!ok) std::cerr << "[license] refresh: " << message << "\n";
        return ok ? "" : message;
    };
    if (licenseId.empty()) return record(false, "no license to refresh");
    int status = 0;
    std::string error;
    json r = call("/v1/refresh", {{"licenseId", licenseId}}, status, error);
    if (status == 410 && r.is_object() && r.value("revoked", false)) {
        // Revoked: this PC stops being licensed (the setup locks once enforced; the walls play on).
        std::lock_guard lock(mutex_);
        std::error_code ec;
        auto revoked = file_;
        revoked.replace_filename("license-revoked.json");
        fs::rename(file_, revoked, ec);
        std::cerr << "[license] the license server says this license was revoked\n";
        lastRefresh_ = {{"time", formatTime(nowSeconds())}, {"ok", false}, {"message", "the license was revoked"}};
        return "the license was revoked";
    }
    if (!error.empty()) return record(false, error);
    if (auto why = install(r.value("license", "")); !why.empty()) return record(false, why);
    return record(true, "up to date");
}

void Manager::deactivate() {
    Status s = status();
    std::string licenseId = s.payload.is_object() ? s.payload.value("licenseId", "") : "";
    if (!licenseId.empty()) {
        std::lock_guard serial(refreshMutex_);
        int status = 0;
        std::string error;
        call("/v1/deactivate", {{"licenseId", licenseId}}, status, error);  // best effort: offline is fine
    }
    remove();
}

void Manager::refreshLoop() {
    // A minute after start, then daily; every 6 hours while the server can't be reached.
    auto wait = std::chrono::minutes(1);
    for (;;) {
        {
            std::unique_lock lock(stopMutex_);
            if (stopCv_.wait_for(lock, wait, [this] { return stopping_; })) return;
        }
        Status s = status();
        if (!s.payload.is_object()) {
            wait = std::chrono::hours(6);
            continue;
        }
        bool ok = refreshNow().empty();
        wait = ok ? std::chrono::hours(24) : std::chrono::hours(6);
    }
}

void Manager::touchClock(int64_t now) {
    if (now <= lastSeen_) return;
    lastSeen_ = now;
    if (now - lastSaved_ < 3600) return;
    lastSaved_ = now;
    writeFileAtomic(stateFile_, json{{"lastSeen", lastSeen_}}.dump() + "\n");
}

Status Manager::status() {
    std::lock_guard lock(mutex_);
    int64_t now = nowSeconds();
    std::string text;
    std::error_code ec;
    if (fs::exists(file_, ec)) text = readFile(file_);
    Status s = evaluate(text, keys_, here_, now, lastSeen_);
    if (s.reason.find("clock") == std::string::npos) touchClock(now);  // a clock set back never moves lastSeen back
    return s;
}

json Manager::statusJson(const Usage& usage) {
    Status s = status();
    const json p = s.payload.is_object() ? s.payload : json::object();
    json j = {
        {"state", s.state},
        {"reason", s.reason},
        {"enforced", enforce_},
        {"plan", s.plan},
        {"customer", p.value("customer", "")},
        {"licenseId", p.value("licenseId", "")},
        {"trial", p.value("trial", false)},
        {"maxScreens", s.maxScreens},
        {"features", s.features},
        {"issuedAt", p.value("issuedAt", "")},
        {"expires", s.expires ? json(formatTime(s.expires)) : json(nullptr)},
        {"graceUntil", s.graceUntil ? json(formatTime(s.graceUntil)) : json(nullptr)},
        {"daysLeft", s.daysLeft},
        {"updatesUntil", p.value("updatesUntil", "")},
        {"used", usage.toJson()},
        {"locks", {{"setup", s.locked()}, {"updates", s.locked()},
                   {"addScreens", s.locked() || (s.maxScreens >= 0 && usage.screens >= s.maxScreens)}}},
        {"machine", here_.toJson()},
        {"links", {{"buy", std::string(kSite) + "/products.html#license"}, {"account", std::string(kSite) + "/account"},
                   {"renew", std::string(kSite) + "/account?renew=" + p.value("licenseId", "")}, {"activate", std::string(kSite) + "/activate"}}},
        {"online", true},
        {"server", server_},
#ifdef MOSAIC_LICENSE_TEST_KEY
        {"testBuild", true},
#else
        {"testBuild", false},
#endif
    };
    std::lock_guard lock(mutex_);
    j["wouldBlock"] = {{"count", wouldBlock_}, {"last", lastBlocked_}};
    j["lastRefresh"] = lastRefresh_;
    return j;
}

std::string Manager::install(const std::string& fileText) {
    Status s;
    {
        std::lock_guard lock(mutex_);
        s = evaluate(fileText, keys_, here_, nowSeconds(), lastSeen_);
    }
    if (s.state == "none") return "that's empty: paste the whole license file";
    if (s.state == "invalid") return "not installed: " + s.reason;
    std::lock_guard lock(mutex_);
    if (!writeFileAtomic(file_, fileText)) return "couldn't save the license file in the data folder";
    std::cerr << "[license] installed: " << s.state << " (" << s.plan << ")\n";
    return "";
}

void Manager::remove() {
    std::lock_guard lock(mutex_);
    std::error_code ec;
    fs::remove(file_, ec);
}

std::string Manager::requestCode(const std::string& key) {
    json j = {{"v", 1}, {"key", key}, {"machine", here_.toJson()}};
#ifdef MOSAIC_VERSION
    j["engine"] = MOSAIC_VERSION;
#endif
    return base64url(j.dump());
}

std::string Manager::refuse(const std::string& what, const std::string& why) {
    std::lock_guard lock(mutex_);
    wouldBlock_++;
    lastBlocked_ = {{"what", what}, {"why", why}, {"time", formatTime(nowSeconds())}, {"refused", enforce_}};
    if (enforce_) std::cerr << "[license] refused " << what << ": " << why << "\n";
    return enforce_ ? why : "";
}

std::string Manager::checkRequest(const std::string& method, const std::string& path, const std::string& body) {
    try {
        Kind k = classify(method, path, body);
        if (k != Kind::Setup && k != Kind::Update) return "";
        Status s = status();
        if (!s.locked()) return "";
        std::string why = lockedMessage(s);
        if (k == Kind::Update) why = "Updates are paused. " + why;
        return refuse(method + " " + path, why);
    } catch (const std::exception& e) {
        return "";  // a failing check never stops a request it can't judge
    }
}

std::string Manager::checkChange(const std::vector<const Layout*>& before, const std::vector<const Layout*>& after) {
    try {
        Usage b = usageOf(before), a = usageOf(after);
        if (a.screens <= b.screens && a.canvases <= b.canvases && a.audioOutputs <= b.audioOutputs && a.captureSources <= b.captureSources)
            return "";  // nothing added: always fine
        std::string why = changeRefusal(status(), b, a);
        if (why.empty()) return "";
        return refuse("a change to " + std::to_string(a.screens) + " screens", why);
    } catch (const std::exception& e) {
        return "";
    }
}

}  // namespace mosaic::license
