// Live2D Companion · macOS 进程输出电平 helper（ADR 0001 · F6 · FR-V3）
//
// 契约（NDJSON stdout， electron/native-process-audio-listener.cjs 消费）：
//   {"type":"waiting","permissionHint":bool}            目标已指定，等待其出现 Core Audio 输出对象
//   {"type":"ready","source":"macOS process audio","pids":[...],"permissionHint":bool}
//   {"type":"level","level":0.0..1.0}                   每 ~33ms 一帧峰值电平
//   {"type":"error","code":"...","message":"...","osStatus":N,"permissionHint":bool}
//
// 用法：
//   live2d-audio-listener --pid <N> [--pid <M> ...] [--wait-timeout-ms <T>]
//   live2d-audio-listener --self-test
//
// 行为要点：
//  - 目标进程尚无 Core Audio 进程对象（未在播放）时默认无限等待（--wait-timeout-ms 0），
//    避免 JS 侧每轮 poll 重 spawn 的 churn；超时 >0 时到点报 no-audio-process 退出码 2。
//  - permissionHint = CGPreflightScreenCaptureAccess()（「屏幕与系统音频录制」TCC 组，
//    仅供 JS 分类 tap-create-failed 是否权限问题；不是授权前置条件）。
//  - 隐私（NFR-1）：只在 IOProc 内对内存缓冲算 RMS→峰值电平，不采麦克风、
//    音频样本不落盘、不上传、不写日志。
//
// 实现说明：Core Audio process tap（AudioHardwareCreateProcessTap + 私有 aggregate
// device）结构借鉴 persona native/macos/PersonaAudioListener.mm（MIT，只读参考）；
// tap/aggregate 命名与协议码为 live2d 系，新增 waiting/permissionHint/unsupported-os。
//
// 构建（见 scripts/build-native-helper.sh）：
//   clang++ -std=c++17 -fobjc-arc -O2 -mmacosx-version-min=14.2 \
//     -framework Foundation -framework CoreAudio -framework CoreGraphics \
//     native/macos/Live2dAudioListener.mm -o native/bin/darwin/live2d-audio-listener

#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <csignal>
#include <cstdlib>
#include <cstring>
#include <cstdio>
#include <thread>
#include <vector>

namespace {

std::atomic<bool> running{true};

AudioObjectPropertyAddress propertyAddress(
    AudioObjectPropertySelector selector,
    AudioObjectPropertyScope scope = kAudioObjectPropertyScopeGlobal,
    AudioObjectPropertyElement element = kAudioObjectPropertyElementMain) {
  return {selector, scope, element};
}

bool permissionHint() {
  // 「屏幕与系统音频录制」TCC 组预检；仅作 JS 侧错误分类提示，不做授权前置。
  return CGPreflightScreenCaptureAccess();
}

void emitJSON(NSDictionary *object) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:&error];
  if (data == nil) return;
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

int fail(NSString *code, NSString *message, OSStatus status = noErr, int exitCode = 1) {
  NSString *detail = message;
  if (status != noErr) {
    detail = [NSString stringWithFormat:@"%@ (OSStatus %d)", message, status];
  }
  emitJSON(@{
    @"type" : @"error",
    @"code" : code,
    @"message" : detail,
    @"osStatus" : @(status),
    @"permissionHint" : @(permissionHint()),
  });
  return exitCode;
}

void handleSignal(int) {
  running.store(false, std::memory_order_relaxed);
}

std::vector<AudioObjectID> audioProcessObjects(
    const std::vector<pid_t>& requestedPids,
    std::vector<pid_t>* resolvedPids = nullptr) {
  auto address = propertyAddress(kAudioHardwarePropertyProcessObjectList);
  UInt32 size = 0;
  if (AudioObjectGetPropertyDataSize(
          kAudioObjectSystemObject, &address, 0, nullptr, &size) != noErr) {
    return {};
  }
  std::vector<AudioObjectID> objects(size / sizeof(AudioObjectID));
  if (objects.empty() ||
      AudioObjectGetPropertyData(
          kAudioObjectSystemObject, &address, 0, nullptr, &size, objects.data()) != noErr) {
    return {};
  }
  objects.resize(size / sizeof(AudioObjectID));

  std::vector<AudioObjectID> matches;
  for (AudioObjectID object : objects) {
    auto pidAddress = propertyAddress(kAudioProcessPropertyPID);
    pid_t pid = 0;
    UInt32 pidSize = sizeof(pid);
    if (AudioObjectGetPropertyData(object, &pidAddress, 0, nullptr, &pidSize, &pid) != noErr) {
      continue;
    }
    if (std::find(requestedPids.begin(), requestedPids.end(), pid) != requestedPids.end()) {
      matches.push_back(object);
      if (resolvedPids != nullptr) resolvedPids->push_back(pid);
    }
  }
  return matches;
}

struct MeterContext {
  AudioStreamBasicDescription format{};
  std::atomic<float> peak{0.0f};
};

double squareSumForBuffer(
    const AudioBuffer& buffer,
    const AudioStreamBasicDescription& format,
    std::size_t& sampleCount) {
  if (buffer.mData == nullptr || buffer.mDataByteSize == 0) return 0.0;
  const bool isFloat = (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0;
  const bool isSigned = (format.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0;
  double sum = 0.0;

  if (isFloat && format.mBitsPerChannel == 32) {
    const auto *samples = static_cast<const float *>(buffer.mData);
    sampleCount = buffer.mDataByteSize / sizeof(float);
    for (std::size_t index = 0; index < sampleCount; ++index) {
      const double sample = std::isfinite(samples[index]) ? samples[index] : 0.0;
      sum += sample * sample;
    }
  } else if (isFloat && format.mBitsPerChannel == 64) {
    const auto *samples = static_cast<const double *>(buffer.mData);
    sampleCount = buffer.mDataByteSize / sizeof(double);
    for (std::size_t index = 0; index < sampleCount; ++index) {
      const double sample = std::isfinite(samples[index]) ? samples[index] : 0.0;
      sum += sample * sample;
    }
  } else if (isSigned && format.mBitsPerChannel == 16) {
    const auto *samples = static_cast<const int16_t *>(buffer.mData);
    sampleCount = buffer.mDataByteSize / sizeof(int16_t);
    for (std::size_t index = 0; index < sampleCount; ++index) {
      const double sample = static_cast<double>(samples[index]) / 32768.0;
      sum += sample * sample;
    }
  } else if (isSigned && format.mBitsPerChannel == 32) {
    const auto *samples = static_cast<const int32_t *>(buffer.mData);
    sampleCount = buffer.mDataByteSize / sizeof(int32_t);
    for (std::size_t index = 0; index < sampleCount; ++index) {
      const double sample = static_cast<double>(samples[index]) / 2147483648.0;
      sum += sample * sample;
    }
  }
  return sum;
}

OSStatus meterIOProc(
    AudioObjectID,
    const AudioTimeStamp *,
    const AudioBufferList *input,
    const AudioTimeStamp *,
    AudioBufferList *,
    const AudioTimeStamp *,
    void *clientData) {
  auto *context = static_cast<MeterContext *>(clientData);
  if (input == nullptr || context == nullptr) return noErr;

  double squareSum = 0.0;
  std::size_t sampleCount = 0;
  for (UInt32 index = 0; index < input->mNumberBuffers; ++index) {
    std::size_t bufferSamples = 0;
    squareSum += squareSumForBuffer(input->mBuffers[index], context->format, bufferSamples);
    sampleCount += bufferSamples;
  }
  if (sampleCount == 0) return noErr;

  const double rms = std::sqrt(squareSum / static_cast<double>(sampleCount));
  const float level =
      static_cast<float>(std::clamp((rms - 0.0025) * 7.5, 0.0, 1.0));
  float previous = context->peak.load(std::memory_order_relaxed);
  while (level > previous &&
         !context->peak.compare_exchange_weak(
             previous, level, std::memory_order_relaxed, std::memory_order_relaxed)) {
  }
  return noErr;
}

}  // namespace

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    std::vector<pid_t> processIds;
    long waitTimeoutMs = 0;  // 0 = 无限等待目标出声（默认，避免 JS 侧 respawn churn）
    for (int index = 1; index < argc; ++index) {
      if (strcmp(argv[index], "--self-test") == 0) {
        emitJSON(@{
          @"type" : @"ready",
          @"source" : @"macOS self-test",
          @"permissionHint" : @(permissionHint()),
        });
        return 0;
      }
      if (strcmp(argv[index], "--pid") == 0 && index + 1 < argc) {
        const long value = strtol(argv[++index], nullptr, 10);
        if (value > 0) processIds.push_back(static_cast<pid_t>(value));
        continue;
      }
      if (strcmp(argv[index], "--wait-timeout-ms") == 0 && index + 1 < argc) {
        waitTimeoutMs = std::max(0L, strtol(argv[++index], nullptr, 10));
        continue;
      }
    }
    if (processIds.empty()) {
      return fail(@"no-pid", @"At least one --pid is required.");
    }
    if (@available(macOS 14.2, *)) {
      // Core Audio process tap 需要 macOS 14.2+
    } else {
      return fail(@"unsupported-os", @"Core Audio process tap requires macOS 14.2 or later.");
    }

    // 等待目标进程出现 Core Audio 输出对象（目标已匹配但尚未在播放）
    emitJSON(@{@"type" : @"waiting", @"permissionHint" : @(permissionHint())});
    std::vector<pid_t> resolvedPids;
    std::vector<AudioObjectID> processObjects;
    const auto waitDeadline =
        std::chrono::steady_clock::now() + std::chrono::milliseconds(waitTimeoutMs);
    while (running.load(std::memory_order_relaxed)) {
      resolvedPids.clear();
      processObjects = audioProcessObjects(processIds, &resolvedPids);
      if (!processObjects.empty()) break;
      if (waitTimeoutMs > 0 && std::chrono::steady_clock::now() >= waitDeadline) {
        return fail(
            @"no-audio-process",
            @"No active Core Audio process matches the requested application.",
            noErr,
            2);
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(250));
    }
    if (processObjects.empty()) return 0;  // 被信号终止

    NSMutableArray<NSNumber *> *processNumbers =
        [NSMutableArray arrayWithCapacity:processObjects.size()];
    for (AudioObjectID object : processObjects) {
      [processNumbers addObject:@(object)];
    }
    CATapDescription *tapDescription =
        [[CATapDescription alloc] initStereoMixdownOfProcesses:processNumbers];
    if (tapDescription == nil) {
      return fail(@"tap-create-failed", @"Unable to configure the Core Audio process tap.");
    }
    tapDescription.name = @"Live2D voice output meter";
    [tapDescription setPrivate:YES];

    AudioObjectID tapID = kAudioObjectUnknown;
    OSStatus status = AudioHardwareCreateProcessTap(tapDescription, &tapID);
    if (status != noErr) {
      return fail(@"tap-create-failed", @"Unable to create a Core Audio process tap.", status);
    }

    CFStringRef tapUIDRef = nullptr;
    auto tapUIDAddress = propertyAddress(kAudioTapPropertyUID);
    UInt32 tapUIDSize = sizeof(tapUIDRef);
    status = AudioObjectGetPropertyData(
        tapID, &tapUIDAddress, 0, nullptr, &tapUIDSize, &tapUIDRef);
    if (status != noErr || tapUIDRef == nullptr) {
      AudioHardwareDestroyProcessTap(tapID);
      return fail(@"tap-uid-failed", @"Unable to read the Core Audio tap identifier.", status);
    }
    NSString *tapUID = [(__bridge NSString *)tapUIDRef copy];
    CFRelease(tapUIDRef);

    NSString *aggregateUID = [NSString stringWithFormat:@"com.live2d.companion.%@",
                                                        NSUUID.UUID.UUIDString];
    NSDictionary *aggregateDescription = @{
      @kAudioAggregateDeviceNameKey : @"Live2D Output Meter",
      @kAudioAggregateDeviceUIDKey : aggregateUID,
      @kAudioAggregateDeviceIsPrivateKey : @YES,
      @kAudioAggregateDeviceTapAutoStartKey : @YES,
    };
    AudioObjectID aggregateID = kAudioObjectUnknown;
    status = AudioHardwareCreateAggregateDevice(
        (__bridge CFDictionaryRef)aggregateDescription, &aggregateID);
    if (status != noErr) {
      AudioHardwareDestroyProcessTap(tapID);
      return fail(@"aggregate-failed", @"Unable to create a private Core Audio aggregate device.", status);
    }

    CFArrayRef tapList = (__bridge CFArrayRef)@[ tapUID ];
    auto tapListAddress = propertyAddress(kAudioAggregateDevicePropertyTapList);
    UInt32 tapListSize = sizeof(tapList);
    status = AudioObjectSetPropertyData(
        aggregateID, &tapListAddress, 0, nullptr, tapListSize, &tapList);
    if (status != noErr) {
      AudioHardwareDestroyAggregateDevice(aggregateID);
      AudioHardwareDestroyProcessTap(tapID);
      return fail(@"tap-attach-failed", @"Unable to attach the process tap to its aggregate device.", status);
    }

    MeterContext meter;
    // Core Audio 异步发布 aggregate 的 tapped 输入流；轮询两个 scope 直到流出现
    // （直接首读会间歇 kAudioHardwareBadObjectError——persona 已实证该竞态）。
    const AudioObjectPropertyScope formatScopes[] = {
        kAudioDevicePropertyScopeInput,
        kAudioObjectPropertyScopeGlobal,
    };
    status = kAudioHardwareBadObjectError;
    const auto formatDeadline =
        std::chrono::steady_clock::now() + std::chrono::seconds(3);
    while (true) {
      for (const AudioObjectPropertyScope scope : formatScopes) {
        auto formatAddress =
            propertyAddress(kAudioDevicePropertyStreamFormat, scope);
        UInt32 formatSize = sizeof(meter.format);
        const OSStatus readStatus = AudioObjectGetPropertyData(
            aggregateID, &formatAddress, 0, nullptr, &formatSize, &meter.format);
        if (readStatus == noErr && meter.format.mSampleRate > 0 &&
            meter.format.mBitsPerChannel > 0) {
          status = noErr;
          break;
        }
        status = readStatus != noErr ? readStatus : kAudioHardwareBadObjectError;
      }
      if (status == noErr) break;
      if (std::chrono::steady_clock::now() >= formatDeadline) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(25));
    }

    if (status != noErr) {
      AudioHardwareDestroyAggregateDevice(aggregateID);
      AudioHardwareDestroyProcessTap(tapID);
      return fail(@"format-failed", @"Unable to read the tapped stream format.", status);
    }

    AudioDeviceIOProcID ioProcID = nullptr;
    status = AudioDeviceCreateIOProcID(aggregateID, meterIOProc, &meter, &ioProcID);
    if (status == noErr) status = AudioDeviceStart(aggregateID, ioProcID);
    if (status != noErr) {
      if (ioProcID != nullptr) AudioDeviceDestroyIOProcID(aggregateID, ioProcID);
      AudioHardwareDestroyAggregateDevice(aggregateID);
      AudioHardwareDestroyProcessTap(tapID);
      return fail(@"start-failed", @"Unable to start the Core Audio output meter.", status);
    }

    signal(SIGINT, handleSignal);
    signal(SIGTERM, handleSignal);
    NSMutableArray<NSNumber *> *resolvedNumbers =
        [NSMutableArray arrayWithCapacity:resolvedPids.size()];
    for (pid_t pid : resolvedPids) [resolvedNumbers addObject:@(pid)];
    emitJSON(@{
      @"type" : @"ready",
      @"source" : @"macOS process audio",
      @"pids" : resolvedNumbers,
      @"permissionHint" : @(permissionHint()),
    });

    while (running.load(std::memory_order_relaxed)) {
      std::this_thread::sleep_for(std::chrono::milliseconds(33));
      const float level = meter.peak.exchange(0.0f, std::memory_order_relaxed);
      emitJSON(@{@"type" : @"level", @"level" : @(level)});
    }

    AudioDeviceStop(aggregateID, ioProcID);
    AudioDeviceDestroyIOProcID(aggregateID, ioProcID);
    AudioHardwareDestroyAggregateDevice(aggregateID);
    AudioHardwareDestroyProcessTap(tapID);
    return 0;
  }
}
