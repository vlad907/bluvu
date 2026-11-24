// `mosaic_engine --gpu-self-test`: which GPU a canvas picks (core/gpu_choice.hpp), on a made-up
// PC like the venue's: two cards of the same model that Windows numbers either way round, and a third.
#include <iostream>

#include "core/gpu_choice.hpp"

namespace mosaic {

int gpuChoiceSelfTest() {
    int failed = 0;
    auto check = [&](bool ok, const char* what) {
        std::cout << (ok ? "ok    " : "FAIL  ") << what << "\n";
        if (!ok) ++failed;
    };
    auto card = [](int index, const char* name, int64_t luid, std::vector<std::pair<const char*, const char*>> monitors) {
        GpuInfo g;
        g.index = index;
        g.name = name;
        g.luid = luid;
        for (auto& [display, id] : monitors) {
            GpuOutputInfo m;
            m.name = display;
            m.id = id;
            g.outputs.push_back(m);
        }
        return g;
    };
    // As set up: card A (luid 100) is number 1 with the ultrawide, card B (luid 200) number 2 with the TV.
    std::vector<GpuInfo> asSetUp = {card(0, "P4000", 100, {{"DISPLAY10", "ultrawide"}}), card(1, "P4000", 200, {{"DISPLAY5", "tv"}}), card(2, "5060", 300, {})};
    // After a reboot: the two same cards the other way round, and the monitors renamed.
    std::vector<GpuInfo> swapped = {card(0, "P4000", 200, {{"DISPLAY3", "tv"}}), card(1, "P4000", 100, {{"DISPLAY4", "ultrawide"}}), card(2, "5060", 300, {})};
    // Early in a boot: the cards the other way round and no monitor on yet.
    std::vector<GpuInfo> dark = {card(0, "P4000", 200, {}), card(1, "P4000", 100, {}), card(2, "5060", 300, {})};

    Layout wide;  // a canvas on GPU 1 showing on the ultrawide
    wide.gpu = 0;
    wide.gpuName = "P4000";
    OutputConfig o;
    o.id = "out-1";
    o.enabled = true;
    o.display = "DISPLAY10";
    o.displayId = "ultrawide";
    wide.outputs.push_back(o);

    GpuChoice c = chooseGpu(wide, asSetUp);
    check(c.index == 0 && c.luid == 100, "as set up: the canvas is on the card its monitor is on");
    c = chooseGpu(wide, swapped);
    check(c.index == 1 && c.luid == 100, "cards numbered the other way round: it follows its monitor to the same card");
    c = chooseGpu(wide, dark);
    check(c.index == 0 && c.luid == 200, "no monitor on yet: it starts on the card with its number");
    c = chooseGpu(wide, swapped, 200);
    check(c.luid == 100, "the monitor comes on on the other card: it moves there");
    c = chooseGpu(wide, asSetUp, 100);
    check(c.index == 0 && c.luid == 100, "already on the right card: it stays");

    Layout learnedLater = wide;  // an output that never learned its monitor goes by the display name
    learnedLater.outputs[0].displayId.clear();
    c = chooseGpu(learnedLater, asSetUp);
    check(c.luid == 100, "an output without a learned monitor goes by its display name");

    Layout off = wide;  // a display output that's turned off doesn't decide
    off.outputs[0].enabled = false;
    c = chooseGpu(off, swapped);
    check(c.index == 0 && c.luid == 200, "a display output that's off doesn't decide the card");

    Layout plain;  // no display outputs: NDI only
    plain.gpu = 1;
    plain.gpuName = "P4000";
    c = chooseGpu(plain, asSetUp);
    check(c.index == 1 && c.luid == 200, "no display outputs: the card with its number");
    c = chooseGpu(plain, swapped, 200);
    check(c.index == 0 && c.luid == 200, "no display outputs, cards renumbered: it stays on the card it's on");

    Layout other = wide;  // set to the third card: its monitors on the P4000s don't pull it off that
    other.gpu = 2;
    other.gpuName = "5060";
    c = chooseGpu(other, asSetUp);
    check(c.index == 2 && c.luid == 300, "a canvas set to another model of card stays on it");
    std::vector<GpuInfo> moved = {card(0, "5060", 300, {}), card(1, "P4000", 100, {}), card(2, "P4000", 200, {})};
    c = chooseGpu(other, moved);
    check(c.index == 0 && c.luid == 300, "a card that moved to another number is found by name");

    Layout standard;  // the system's default GPU
    c = chooseGpu(standard, asSetUp, 100);
    check(c.index == -1 && c.luid == 0, "the default GPU stays the default");
    Layout missing = plain;
    missing.gpu = 5;
    missing.gpuName = "Gone";
    c = chooseGpu(missing, asSetUp);
    check(c.index == 5 && c.luid == 0, "a card that isn't there: as numbered, so it fails clearly");

    std::cout << (failed ? "FAILED\n" : "all passed\n");
    return failed ? 1 : 0;
}

}  // namespace mosaic
