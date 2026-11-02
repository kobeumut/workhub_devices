#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

@interface RCT_EXTERN_MODULE(WorkhubNative, RCTEventEmitter)
RCT_EXTERN_METHOD(secretGet:(NSString *)k resolver:(RCTPromiseResolveBlock)r rejecter:(RCTPromiseRejectBlock)j)
RCT_EXTERN_METHOD(secretSet:(NSString *)k value:(NSString *)v resolver:(RCTPromiseResolveBlock)r rejecter:(RCTPromiseRejectBlock)j)
RCT_EXTERN_METHOD(secretDelete:(NSString *)k resolver:(RCTPromiseResolveBlock)r rejecter:(RCTPromiseRejectBlock)j)
RCT_EXTERN_METHOD(plainGet:(NSString *)k resolver:(RCTPromiseResolveBlock)r rejecter:(RCTPromiseRejectBlock)j)
RCT_EXTERN_METHOD(plainSet:(NSString *)k value:(NSString *)v resolver:(RCTPromiseResolveBlock)r rejecter:(RCTPromiseRejectBlock)j)
RCT_EXTERN_METHOD(plainDelete:(NSString *)k resolver:(RCTPromiseResolveBlock)r rejecter:(RCTPromiseRejectBlock)j)
RCT_EXTERN_METHOD(plainDeletePrefix:(NSString *)p resolver:(RCTPromiseResolveBlock)r rejecter:(RCTPromiseRejectBlock)j)
RCT_EXTERN_METHOD(pushPrepare:(NSString *)tag serverBase:(NSString *)s loginName:(NSString *)l secretKey:(NSString *)k resolver:(RCTPromiseResolveBlock)r rejecter:(RCTPromiseRejectBlock)j)
RCT_EXTERN_METHOD(pushForget:(NSString *)tag resolver:(RCTPromiseResolveBlock)r rejecter:(RCTPromiseRejectBlock)j)
RCT_EXTERN_METHOD(consumeInitialRoute:(RCTPromiseResolveBlock)r rejecter:(RCTPromiseRejectBlock)j)
RCT_EXTERN_METHOD(setForeground:(NSString *)tag room:(NSString *)room)
RCT_EXTERN_METHOD(requestNotificationPermission:(RCTPromiseResolveBlock)r rejecter:(RCTPromiseRejectBlock)j)
RCT_EXTERN_METHOD(shareFile:(NSString *)filename content:(NSString *)content mime:(NSString *)mime resolver:(RCTPromiseResolveBlock)r rejecter:(RCTPromiseRejectBlock)j)
@end
