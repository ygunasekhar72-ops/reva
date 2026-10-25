#include <string.h>
#include <jni.h>
#include <node.h>

// JNI bridge: packs a Java String[] into a contiguous argv (libuv requires
// contiguous memory) and hands it to the embedded Node runtime.
// Must match package com.reva.harness / class NodeRunner.
extern "C" JNIEXPORT jint JNICALL
Java_com_reva_harness_NodeRunner_startNodeWithArguments(JNIEnv *env,
                                                        jobject /* this */,
                                                        jobjectArray arguments) {
    int argc = env->GetArrayLength(arguments);
    if (argc <= 0) return 1;

    char *argv[argc];
    for (int i = 0; i < argc; i++) {
        jstring arg = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *argStr = env->GetStringUTFChars(arg, nullptr);
        argv[i] = strdup(argStr);
        env->ReleaseStringUTFChars(arg, argStr);
    }

    node::Start(argc, argv);

    for (int i = 0; i < argc; i++) {
        free(argv[i]);
    }
    return 0;
}
