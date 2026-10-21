// Offline public-fixture parity/latency harness. No keys or network.
#include <dlfcn.h>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>
struct Buffer {uint8_t *ptr;size_t len;size_t cap;};
int main(int argc,char**argv){
 if(argc!=4)return 2;void*lib=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);if(!lib)return 3;
 auto call=reinterpret_cast<Buffer(*)(const uint8_t*,size_t,const uint8_t*,size_t)>(dlsym(lib,"tbc_engine_call"));
 auto release=reinterpret_cast<void(*)(Buffer)>(dlsym(lib,"tbc_engine_free"));if(!call||!release)return 4;
 const std::string input((std::istreambuf_iterator<char>(std::cin)),{}),method(argv[2]);
 const int n=std::stoi(argv[3]);if(n<1||n>100)return 5;std::vector<double>times;std::string result;
 for(int i=0;i<=n;i++){
  const auto start=std::chrono::steady_clock::now();auto b=call(reinterpret_cast<const uint8_t*>(method.data()),method.size(),reinterpret_cast<const uint8_t*>(input.data()),input.size());
  if(!b.ptr||b.len>64*1024*1024)return 6;result.assign(reinterpret_cast<const char*>(b.ptr),b.len);release(b);
  if(i)times.push_back(std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count());
 }
 std::cout<<"{\"result\":"<<result<<",\"warmMs\":[";for(size_t i=0;i<times.size();i++){if(i)std::cout<<',';std::cout<<times[i];}std::cout<<"]}";dlclose(lib);
}
