// For tests only (MOSAIC_TEST_NDI_SENDER_FAILS=N): an NDI system with no network whose senders
// can't be created the first N times for each stream name, as happens for real when a stream
// being closed still holds its name. Checks that the engine keeps trying instead of giving up.
#pragma once

#include <map>
#include <mutex>
#include <string>

#include "io/video_io.hpp"

namespace mosaic {

class TestNdiSystem final : public NdiSystem {
public:
    explicit TestNdiSystem(int failures) : failures_(failures) {}
    std::string version() const override { return "test (no network)"; }
    std::vector<std::string> discoveredSources() override { return {}; }
    std::unique_ptr<VideoSink> createSender(const std::string& name) override {
        std::lock_guard l(m_);
        if (tries_[name]++ < failures_) return nullptr;
        return std::make_unique<Sink>();
    }
    std::unique_ptr<NdiReceiver> createReceiver(const std::string&) override { return nullptr; }
    std::unique_ptr<NdiAudioInput> createAudioReceiver(const std::string&, std::shared_ptr<AudioRing>) override { return nullptr; }

private:
    class Sink final : public VideoSink {
    public:
        std::string kind() const override { return "ndi"; }
        void send(const VideoFrameView&) override {}
        int connections() const override { return 0; }
    };
    int failures_;
    std::mutex m_;
    std::map<std::string, int> tries_;
};

}  // namespace mosaic
