cmake_minimum_required(VERSION 3.22.1)
project(reva LANGUAGES CXX)

# NODE_LIBS_DIR is passed from app/build.gradle and points at the extracted
# nodejs-mobile release (android/libs/nodejs: bin/<abi>/libnode.so + include/).
set(NODE_LIBS_DIR "" CACHE PATH "Path to the extracted nodejs-mobile release")

add_library(native-lib SHARED native-lib.cpp)

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION
        "${NODE_LIBS_DIR}/bin/${ANDROID_ABI}/libnode.so")

target_include_directories(native-lib PRIVATE
        "${NODE_LIBS_DIR}/include"
        "${NODE_LIBS_DIR}/include/node")

target_link_libraries(native-lib node)
