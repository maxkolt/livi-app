#include <jsc/JSCRuntime.h>
#include <jsi/jsi.h>

#include "JsiPromises.h"

#include <cassert>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <thread>

namespace jsi = facebook::jsi;
using Promise = RNJsi::JsiPromises::Promise;

static void evaluate(jsi::Runtime &runtime, const std::string &script) {
  runtime.evaluateJavaScript(std::make_shared<jsi::StringBuffer>(script), "skia-lifecycle-test");
}

static std::shared_ptr<Promise> start(jsi::Runtime &runtime) {
  std::shared_ptr<Promise> handle;
  auto value = RNJsi::JsiPromises::createPromiseAsJSIValue(
      runtime, [&](std::shared_ptr<Promise> promise) { handle = std::move(promise); });
  runtime.global().setProperty(runtime, "pending", std::move(value));
  evaluate(runtime, "globalThis.result = ''; pending.then(v => result = 'ok:' + v, e => result = 'error:' + e.message)");
  return handle;
}

static std::string result(jsi::Runtime &runtime) {
  // JSC drains its promise jobs at the evaluation boundary.
  evaluate(runtime, "void 0");
  return runtime.global().getProperty(runtime, "result").asString(runtime).utf8(runtime);
}

int main() {
  {
    auto runtime = facebook::jsc::makeJSCRuntime();
    auto handle = start(*runtime);
    int factories = 0;
    handle->resolve([&](jsi::Runtime &) { factories++; return jsi::Value(42); });
    handle->resolve([&](jsi::Runtime &) { factories++; return jsi::Value(100); });
    handle->reject("duplicate");
    assert(result(*runtime) == "ok:42");
    assert(factories == 1);
  }
  {
    auto runtime = facebook::jsc::makeJSCRuntime();
    auto handle = start(*runtime);
    handle->reject("network");
    handle->resolve([](jsi::Runtime &) { assert(false); return jsi::Value(); });
    assert(result(*runtime) == "error:network");
  }
  {
    auto runtime = facebook::jsc::makeJSCRuntime();
    auto handle = start(*runtime);
    handle->resolve([](jsi::Runtime &) -> jsi::Value { throw std::runtime_error("decode"); });
    assert(result(*runtime) == "error:decode");
  }
  {
    auto runtime = facebook::jsc::makeJSCRuntime();
    auto value = RNJsi::JsiPromises::createPromiseAsJSIValue(
        *runtime, [](std::shared_ptr<Promise>) { throw std::runtime_error("setup"); });
    runtime->global().setProperty(*runtime, "pending", std::move(value));
    evaluate(*runtime, "globalThis.result = ''; pending.catch(e => result = 'error:' + e.message)");
    assert(result(*runtime) == "error:setup");
  }
  // Pending success/failure and destruction on a loader thread must remain safe
  // after teardown, including when the next runtime has already been created.
  for (int iteration = 0; iteration < 100; iteration++) {
    auto runtime = facebook::jsc::makeJSCRuntime();
    auto success = start(*runtime);
    auto failure = start(*runtime);
    auto abandoned = start(*runtime);
    runtime.reset();
    auto nextRuntime = facebook::jsc::makeJSCRuntime();
    auto current = start(*nextRuntime);
    bool staleFactoryCalled = false;
    success->resolve([&](jsi::Runtime &) {
      staleFactoryCalled = true;
      return jsi::Value(1);
    });
    failure->reject("late error");
    std::thread([handle = std::move(abandoned)]() mutable { handle.reset(); }).join();
    assert(!staleFactoryCalled);
    assert(result(*nextRuntime).empty());
    current->resolve([](jsi::Runtime &) { return jsi::Value(7); });
    assert(result(*nextRuntime) == "ok:7");
  }
  std::cout << "Skia Promise lifecycle: success/error/duplicate/setup/factory and 100 teardown generations PASS\n";
}
