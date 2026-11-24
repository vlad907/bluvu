#include "core/canvases.hpp"

#include <algorithm>
#include <iostream>
#include <set>

namespace mosaic {

CanvasRun::~CanvasRun() {
    if (engine) engine->stop();
    engine.reset();  // before the device it renders on
    renderer.reset();
}

Canvases::Canvases(LayoutStore& store, NdiSystem* ndi, RendererOptions renderer, std::filesystem::path mediaDir)
    : store_(store), ndi_(ndi), rendererOptions_(renderer), mediaDir_(std::move(mediaDir)) {}

Canvases::~Canvases() {
    std::map<std::string, std::shared_ptr<CanvasRun>> runs;
    {
        std::lock_guard l(m_);
        runs.swap(runs_);
    }
}

std::vector<GpuInfo> Canvases::gpus() const {
    std::lock_guard l(gpuMutex_);
    auto now = std::chrono::steady_clock::now();
    if (gpusAt_ == std::chrono::steady_clock::time_point{} || now - gpusAt_ > std::chrono::seconds(5)) {
        gpus_ = listGpus();
        gpusAt_ = now;
    }
    return gpus_;
}

GpuChoice Canvases::resolveGpu(const Layout& l, int64_t runningOn) const {
    if (l.gpu < 0) return {};
    return chooseGpu(l, gpus(), runningOn);
}

void Canvases::sync() {
    auto slots = store_.canvases();
    std::vector<std::shared_ptr<CanvasRun>> stopping;  // destroyed outside the lock (joins render threads)
    std::map<std::string, GpuChoice> wantGpu;
    for (auto& c : slots)
        if (auto l = store_.snapshot(c.id)) {
            auto run = get(c.id);
            wantGpu[c.id] = resolveGpu(*l, run ? run->gpuLuid : 0);
        }
    {
        std::lock_guard l(m_);
        for (auto it = runs_.begin(); it != runs_.end();) {
            bool keep = std::any_of(slots.begin(), slots.end(), [&](auto& c) { return c.id == it->first; });
            auto& run = it->second;
            bool failed = !run->engine ? !run->error.empty() : run->engine->failed();
            if (keep && failed && std::chrono::steady_clock::now() - run->started > std::chrono::seconds(3 + std::min(run->restarts, 10) * 3)) {
                // Its GPU device was lost or it couldn't start: try again (waiting longer each time).
                std::cerr << "[canvas] " << it->first << " starts again (" << (run->engine ? run->engine->failure() : run->error) << ")\n";
                restarts_[it->first] = run->restarts + 1;
                keep = false;
            }
            if (keep && wantGpu.count(it->first)) {
                const GpuChoice& want = wantGpu[it->first];
                // The same card under another number (Windows renumbered them) is no move.
                bool sameCard = want.luid && run->gpuLuid ? want.luid == run->gpuLuid : want.index == run->gpu;
                if (sameCard) {
                    run->gpu = want.index;
                } else {
                    // Moved to another GPU (in the editor, or its monitors turned out to be on the
                    // other card of that model): started again there (its streams pause for a moment).
                    std::cerr << "[canvas] " << it->first << " moves to " << (want.index < 0 ? std::string("the default GPU") : "GPU " + std::to_string(want.index + 1)) << "\n";
                    keep = false;
                }
            }
            if (keep) {
                ++it;
                continue;
            }
            std::cerr << "[canvas] " << it->first << " stopped\n";
            stopping.push_back(std::move(it->second));
            it = runs_.erase(it);
        }
    }
    // Stopped (render threads joined, NDI senders closed) before anything starts again, so a
    // canvas moving to another GPU never sends its streams twice. A request still holding one
    // keeps it until it finishes.
    stopping.clear();
    {
        std::lock_guard l(m_);
        for (auto& c : slots) {
            if (runs_.count(c.id)) continue;
            auto run = std::make_shared<CanvasRun>();
            RendererOptions ro = rendererOptions_;
            const GpuChoice want = wantGpu.count(c.id) ? wantGpu[c.id] : GpuChoice{};
            ro.gpu = run->gpu = want.index;
            ro.gpuLuid = run->gpuLuid = want.luid;
            run->restarts = restarts_.count(c.id) ? restarts_[c.id] : 0;
            run->renderer = createRenderer(ro, run->error);
            if (run->renderer) {
                run->engine = std::make_unique<Engine>(*run->renderer, store_, ndi_, c.id);
                run->engine->setMediaDir(mediaDir_);
                run->engine->start();
                std::cerr << "[canvas] " << c.id << " (" << c.layout << ") on " << run->renderer->deviceName() << "\n";
            } else {
                std::cerr << "[canvas] " << c.id << ": GPU init failed: " << run->error << "\n";
            }
            runs_[c.id] = run;
        }
    }
}

std::shared_ptr<CanvasRun> Canvases::get(const std::string& canvasId) const {
    std::lock_guard l(m_);
    auto it = runs_.find(canvasId);
    return it == runs_.end() ? nullptr : it->second;
}

std::shared_ptr<CanvasRun> Canvases::current() const { return get(store_.currentCanvas()); }

std::shared_ptr<CanvasRun> Canvases::primary() const {
    auto slots = store_.canvases();
    return slots.empty() ? nullptr : get(slots.front().id);
}

std::vector<std::pair<std::string, std::shared_ptr<CanvasRun>>> Canvases::all() const {
    std::vector<std::pair<std::string, std::shared_ptr<CanvasRun>>> out;
    for (auto& c : store_.canvases()) out.emplace_back(c.id, get(c.id));
    return out;
}

std::vector<std::string> Canvases::problems() const {
    std::vector<std::string> out;
    std::map<std::string, std::string> owner;  // NDI name -> layout sending it
    for (auto& l : store_.running())
        for (auto& o : l->outputs) {
            if (!o.enabled || o.ndiName.empty()) continue;
            auto [it, fresh] = owner.emplace(o.ndiName, l->name.empty() ? l->id : l->name);
            if (!fresh && it->second != (l->name.empty() ? l->id : l->name))
                out.push_back("NDI stream '" + o.ndiName + "' is sent by both " + it->second + " and " + (l->name.empty() ? l->id : l->name) +
                              ": rename one, or receivers may show the wrong canvas");
        }
    return out;
}

}  // namespace mosaic
