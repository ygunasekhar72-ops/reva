package com.reva.harness;

/**
 * Thin JNI wrapper over the embedded Node.js runtime (nodejs-mobile libnode).
 * The native bridge is built from src/main/cpp/native-lib.cpp; the libnode.so
 * binaries per ABI are packaged from android/libs/nodejs/bin (fetched from the
 * nodejs-mobile release by CI — see .github/workflows/android-build.yml).
 */
public class NodeRunner {
    static {
        System.loadLibrary("node");
        System.loadLibrary("native-lib");
    }

    public native Integer startNodeWithArguments(String[] arguments);

    /** Starts the runtime on a background thread, exactly once per process. */
    public void start(final String scriptPath) {
        new Thread(() -> startNodeWithArguments(new String[]{
                "node", scriptPath,
        }), "reva-node").start();
    }
}
