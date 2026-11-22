// Which monitor a display output goes to, given the monitors that are on right now. Kept apart
// from Windows so it can be checked anywhere (mosaic_engine --monitors).
#pragma once

#include <string>
#include <vector>

#include "render/renderer.hpp"

namespace mosaic {

struct MonitorMatch {
    std::string name;       // the display device to open now ("" = none: see error)
    std::string error;      // why the output waits
    std::string learnedId;  // the monitor's id, when the output only knew its display name
    std::string label;
};

// `display` is the output's display device as chosen ("\\.\DISPLAY3"); `displayId` the monitor it
// stood for then ("" = not known yet). An output whose monitor is known follows that monitor to
// whatever name Windows gives it, and waits while it is off; it never takes another screen.
inline MonitorMatch matchMonitor(const std::string& display, const std::string& displayId, const std::vector<MonitorIdentity>& on) {
    MonitorMatch m;
    if (on.empty()) {  // nothing known about the monitors: go by the name
        m.name = display;
        return m;
    }
    for (auto& mon : on) {
        if (displayId.empty() ? mon.name != display : mon.id != displayId) continue;
        m.name = mon.name;
        m.label = mon.label;
        if (displayId.empty()) m.learnedId = mon.id;
        return m;
    }
    m.error = "its monitor is off or unplugged; the output starts again by itself when the monitor is back";
    return m;
}

}  // namespace mosaic
