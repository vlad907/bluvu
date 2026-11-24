// Where this process's CPU time goes, by thread: answers "what is using the CPU" on the media
// server without a profiler. Threads the engine starts carry a name (nameThread); the others
// (NDI's, Media Foundation's, the GPU driver's) are grouped by the DLL they started in.
#pragma once

#include <string>
#include <vector>

namespace mosaic {

// Names the calling thread (shown here and in debuggers). Best effort.
void nameThread(const std::string& name);

struct CpuGroup {
    std::string name;      // thread name, or "(some.dll)" for unnamed threads started in that DLL
    int threads = 0;
    double percent = 0.0;  // of ONE core: 250 = two and a half cores busy
};

struct CpuUsage {
    int cores = 0;                 // logical processors
    double machinePercent = -1.0;  // whole PC, every program, 0..100 (-1 = unknown)
    double enginePercent = 0.0;    // this process, 0..100 of the whole PC
    std::vector<CpuGroup> groups;  // busiest first; empty where threads can't be listed
};

// Measures over `ms` milliseconds (blocks that long).
CpuUsage measureCpu(int ms);

}  // namespace mosaic
