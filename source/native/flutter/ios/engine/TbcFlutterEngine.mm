#import "TbcFlutterEngine.h"
#include <tbc_engine.h>
#include <stdexcept>
#ifndef TBC_FLUTTER_ARTIFACT_ID
#error A verified native artifact ID is required
#endif
@implementation TbcFlutterEngine
+ (NSString *)artifactIdentity {return @TBC_FLUTTER_ARTIFACT_ID;}
+ (NSString *)call:(NSString *)operation input:(NSString *)input error:(NSError **)error {
  try {
    if(![@[@"normalizeRequest",@"plan",@"validate",@"finalize"] containsObject:operation])throw std::runtime_error("method");
    NSData *method=[operation dataUsingEncoding:NSUTF8StringEncoding],*request=[input dataUsingEncoding:NSUTF8StringEncoding];
    if(!method||!request||request.length>8*1024*1024)throw std::runtime_error("input");
    auto buffer=tbc_engine_call((const uint8_t*)method.bytes,method.length,(const uint8_t*)request.bytes,request.length);
    struct Release {TbcEngineBuffer value;~Release(){tbc_engine_free(value);}} release{buffer};
    if(buffer.len>buffer.cap||buffer.len>16*1024*1024||(buffer.len&&!buffer.ptr))throw std::runtime_error("buffer");
    NSString *response=[[NSString alloc]initWithBytes:buffer.ptr length:buffer.len encoding:NSUTF8StringEncoding];
    if(!response)throw std::runtime_error("encoding");return response;
  } catch (...) {
    if(error)*error=[NSError errorWithDomain:@"TbcFlutterEngine" code:1 userInfo:@{NSLocalizedDescriptionKey:@"NATIVE_ENGINE_FAILED"}];
    return nil;
  }
}
@end
