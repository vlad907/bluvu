// Checks which monitor a display output goes to as screens come and go (core/monitor_match.hpp),
// and lists this PC's monitors with their ids. Run with:  mosaic_engine --monitors
#pragma once

#include <cstdio>

#include "core/monitor_match.hpp"

namespace mosaic {

inline int& monitorMatchFailures() {
    static int n = 0;
    return n;
}
inline void monitorMatchCheck(bool ok, const char* what) {
    std::printf("  %s %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok) ++monitorMatchFailures();
}

// 0 if every case holds.
inline int monitorMatchSelfTest() {
    const MonitorIdentity bar{"\\\\.\\DISPLAY9", "ultrawide@port1", "Ultrawide"}, tv{"\\\\.\\DISPLAY6", "tv@port2", "Outside TV"};

    auto m = matchMonitor("\\\\.\\DISPLAY9", "", {bar, tv});
    monitorMatchCheck(m.error.empty() && m.name == bar.name && m.learnedId == bar.id, "an output that only knows its display name opens there and learns the monitor");

    m = matchMonitor("\\\\.\\DISPLAY9", bar.id, {bar, tv});
    monitorMatchCheck(m.error.empty() && m.name == bar.name && m.learnedId.empty(), "a known monitor on the same name: opens, nothing to learn");

    // The TV is switched off and Windows gives the ultrawide the TV's old name.
    const MonitorIdentity barRenamed{"\\\\.\\DISPLAY6", bar.id, "Ultrawide"};
    m = matchMonitor("\\\\.\\DISPLAY9", bar.id, {barRenamed});
    monitorMatchCheck(m.error.empty() && m.name == "\\\\.\\DISPLAY6", "the ultrawide's output follows it to its new name");
    m = matchMonitor("\\\\.\\DISPLAY6", tv.id, {barRenamed});
    monitorMatchCheck(!m.error.empty() && m.name.empty(), "the TV's output waits: it does not take the ultrawide, though it now has the TV's name");

    m = matchMonitor("\\\\.\\DISPLAY6", tv.id, {barRenamed, {"\\\\.\\DISPLAY2", tv.id, "Outside TV"}});
    monitorMatchCheck(m.error.empty() && m.name == "\\\\.\\DISPLAY2", "the TV is back under another name: its output opens there");

    m = matchMonitor("\\\\.\\DISPLAY6", "", {bar});
    monitorMatchCheck(!m.error.empty(), "an output that only knows a name waits while no monitor has that name");

    m = matchMonitor("\\\\.\\DISPLAY6", tv.id, {});
    monitorMatchCheck(m.error.empty() && m.name == "\\\\.\\DISPLAY6", "nothing known about the monitors (not Windows): goes by the name, as before");

    std::printf("This PC's monitors:\n");
    auto now = listMonitorIdentities();
    for (auto& mon : now) std::printf("  %s  %s  %s\n", mon.name.c_str(), mon.label.empty() ? "(no name)" : mon.label.c_str(), mon.id.c_str());
    if (now.empty()) std::printf("  (none known here)\n");
    std::printf(monitorMatchFailures() ? "\nFAILED\n" : "\nMONITOR MATCH PASSED\n");
    return monitorMatchFailures() ? 1 : 0;
}

}  // namespace mosaic
