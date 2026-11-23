// Licensing for the media server (docs/LICENSING_PLAN.md).
//
// The one rule: licensing never blacks out a wall. Saved layouts load at startup without any
// check; the render threads, outputs and receivers never look at the license. What a license can
// lock is changing the setup, updates, and adding screens, and only when enforcement is on.
// Anything going wrong in here ends as "can't verify": the setup locks, the walls keep playing.
//
// Phase 1 runs in report-only mode: every decision is made and reported (GET /api/license,
// `wouldBlock`) but nothing is refused unless the engine is started with --license-enforce.
#pragma once

#include <cstdint>
#include <filesystem>
#include <mutex>
#include <string>
#include <vector>

#include "license/license_format.hpp"

namespace mosaic {
struct Layout;
}

namespace mosaic::license {

// Hashes of this PC's identifiers (never the identifiers themselves). Empty = couldn't read it.
struct Fingerprint {
    std::string machineGuid;  // Windows MachineGuid (survives Windows updates; changes on reinstall)
    std::string smbiosUuid;   // the motherboard's system UUID
    std::string systemDisk;   // the system volume's serial
    json toJson() const { return {{"machineGuid", machineGuid}, {"smbiosUuid", smbiosUuid}, {"systemDisk", systemDisk}}; }
    static Fingerprint fromJson(const json& j);
};
Fingerprint thisMachine();  // fingerprint.cpp
// How many of the license's (non-empty) identifiers this PC has. Bound when >= min(2, how many the
// license has): a GPU, NIC or disk swap or a Windows reinstall still passes; a new PC doesn't.
bool sameMachine(const Fingerprint& license, const Fingerprint& here);

// What a set of running canvases uses, counted in one place.
struct Usage {
    int screens = 0;       // enabled outputs; an output cut into cells on a receiving PC counts each cell shown
    int canvases = 0;      // walls running at once
    int audioOutputs = 0;  // enabled sound outputs
    int captureSources = 0;
    json toJson() const { return {{"screens", screens}, {"canvases", canvases}, {"audioOutputs", audioOutputs}, {"captureSources", captureSources}}; }
};
Usage usageOf(const std::vector<const Layout*>& running);

// The license as it stands now.
struct Status {
    std::string state = "none";  // trial | valid | expiring | grace | expired | none | invalid
    std::string reason;          // for none / invalid / expired: why, in words
    json payload;                // the verified payload (empty unless it verified)
    std::string plan;            // starter | venue | enterprise | comp | trial
    int maxScreens = 0;          // -1 = unlimited
    std::vector<std::string> features;  // multiCanvas, audio, capture
    int64_t expires = 0;         // 0 = never
    int64_t graceUntil = 0;
    int64_t daysLeft = 0;        // to expiry (or to the end of grace, in grace)
    bool locked() const { return state == "expired" || state == "none" || state == "invalid"; }
    bool has(const std::string& feature) const;
};

// Pure: what a license file means on this PC at this time. lastSeen is the latest time the engine
// has seen (a clock set back more than 2 days before it can't be trusted).
Status evaluate(const std::string& fileText, const std::vector<TrustedKey>& keys, const Fingerprint& here, int64_t now, int64_t lastSeen);

// What a request is, for locking.
enum class Kind {
    Read,       // GET / HEAD / OPTIONS: never locked
    Always,     // licensing itself, the PIN, receiver check-ins: never locked
    Operation,  // day-to-day control at showtime (presets, scenes, show a stream, blank): never locked
    Setup,      // changing the setup: locked when the license is
    Update,     // updating the software: locked when the license is
};
Kind classify(const std::string& method, const std::string& path, const std::string& body);

// Would this change (the running canvases before -> after) be refused? "" = allowed. Only what a
// change *adds* counts: a layout over its limit keeps running, it just can't grow.
std::string changeRefusal(const Status& s, const Usage& before, const Usage& after);

// The trusted keys of this build.
std::vector<TrustedKey> trustedKeys();

// The engine's license: loaded from data/license.json, re-checked every minute.
class Manager {
public:
    Manager(std::filesystem::path dataDir, bool enforce);

    bool enforced() const { return enforce_; }
    Status status();                  // re-evaluated now
    json statusJson(const Usage& usage);
    // Installs a license file. Refused (and the old one kept) unless it verifies on this PC.
    std::string install(const std::string& fileText);
    void remove();
    // The code to paste on the website for an offline activation: the key and this PC's fingerprint.
    std::string requestCode(const std::string& key);

    // The request-path check: "" = go ahead. In report-only mode it records what it would refuse
    // and returns "".
    std::string checkRequest(const std::string& method, const std::string& path, const std::string& body);
    // The layout-store check (LayoutStore::setChangeCheck), same rules.
    std::string checkChange(const std::vector<const Layout*>& before, const std::vector<const Layout*>& after);

private:
    std::string refuse(const std::string& what, const std::string& why);  // records; "" in report-only
    void touchClock(int64_t now);

    std::filesystem::path file_, stateFile_;
    bool enforce_;
    std::vector<TrustedKey> keys_;
    Fingerprint here_;
    std::mutex mutex_;
    int64_t lastSeen_ = 0, lastSaved_ = 0;
    int wouldBlock_ = 0;
    json lastBlocked_;
};

int selfTest();  // license_selftest.cpp: mosaic_engine --license-self-test

}  // namespace mosaic::license
