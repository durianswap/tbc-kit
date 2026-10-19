#import <Foundation/Foundation.h>
NS_ASSUME_NONNULL_BEGIN
@interface TbcFlutterEngine : NSObject
+ (NSString *)artifactIdentity;
+ (nullable NSString *)call:(NSString *)operation input:(NSString *)input error:(NSError **)error NS_SWIFT_NAME(call(_:input:));
@end
NS_ASSUME_NONNULL_END
