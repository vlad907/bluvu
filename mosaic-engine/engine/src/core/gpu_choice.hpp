// Which GPU a canvas renders on.
//
// A layout names its GPU by number and by name. Neither tells two cards of the same model apart,
// and Windows can number them the other way round after a reboot (or once the monitors have all
// come on). A monitor can only be driven by the card it's plugged into, so a canvas with display
// outputs goes to the card of that name its monitors are on; one without stays on the card it's
// already running on.
#pragma once

#include <cstdint>
#include <vector>

#include "core/layout.hpp"
#include "render/renderer.hpp"

namespace mosaic {

struct GpuChoice {
    int index = -1;    // -1 = the system's default GPU
    int64_t luid = 0;  // GpuInfo::luid of that card (0 = not known: go by the number)
};

// `runningOn`: the luid of the card the canvas is on now (0 = not started yet).
inline GpuChoice chooseGpu(const Layout& l, const std::vector<GpuInfo>& gpus, int64_t runningOn = 0) {
    if (l.gpu < 0) return {};
    const GpuInfo* pick = nullptr;
    if (l.gpu < static_cast<int>(gpus.size()) && (l.gpuName.empty() || gpus[static_cast<size_t>(l.gpu)].name == l.gpuName)) {
        pick = &gpus[static_cast<size_t>(l.gpu)];
    } else {
        for (auto& g : gpus)
            if (g.name == l.gpuName) {  // moved: the same card under another number
                pick = &g;
                break;
            }
    }
    if (!pick) return {l.gpu, 0};  // not found by name: as numbered (it fails clearly if there's no such number)
    for (auto& o : l.outputs) {
        if (!o.enabled || o.display.empty()) continue;
        for (auto& g : gpus) {
            if (g.name != pick->name) continue;
            for (auto& m : g.outputs)
                if (o.displayId.empty() || m.id.empty() ? m.name == o.display : m.id == o.displayId) return {g.index, g.luid};
        }
    }
    if (runningOn)
        for (auto& g : gpus)
            if (g.luid == runningOn && g.name == pick->name) return {g.index, g.luid};
    return {pick->index, pick->luid};
}

}  // namespace mosaic
