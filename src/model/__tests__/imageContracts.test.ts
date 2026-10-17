import { describe, expectTypeOf, it } from 'vitest';
import type {
  AgentOptions,
  ImageDetail,
  ImagePolicy,
  ImageRef,
  ImageStore,
  ModelConfig,
  ModelContent,
  ModelImageContent,
  ModelServiceConfig,
  SessionOptions,
  TenantImageStore,
  VisionCapability,
  VisionCapabilityOverride,
  VisionResolver,
} from '../../index.js';

describe('image contracts', () => {
  it('keeps image_url as the only image part and widens its payload to ImageRef', () => {
    expectTypeOf<ModelImageContent['image_url']>().toEqualTypeOf<ImageRef>();
    expectTypeOf<ModelContent['type']>().toEqualTypeOf<'text' | 'image_url'>();
    expectTypeOf<{ url: string }>().toMatchTypeOf<ImageRef>();
    expectTypeOf<ImageDetail>().toEqualTypeOf<'auto' | 'low' | 'high'>();
  });

  it('declares vision capability on models, sessions and service configs', () => {
    expectTypeOf<ModelConfig['vision']>().toEqualTypeOf<VisionCapabilityOverride | undefined>();
    expectTypeOf<ModelServiceConfig['vision']>().toEqualTypeOf<VisionCapability | undefined>();
    expectTypeOf<SessionOptions['vision']>().toEqualTypeOf<
      VisionCapabilityOverride | VisionResolver | undefined
    >();
    expectTypeOf<VisionCapability['imageTokens']>().toEqualTypeOf<
      'openai' | 'anthropic' | 'gemini' | number | undefined
    >();
  });

  it('declares the image policy and the store ports', () => {
    expectTypeOf<SessionOptions['images']>().toEqualTypeOf<ImagePolicy | undefined>();
    expectTypeOf<NonNullable<AgentOptions['advanced']>['images']>().toEqualTypeOf<
      ImagePolicy | undefined
    >();
    expectTypeOf<ImagePolicy['store']>().toEqualTypeOf<ImageStore | undefined>();
    expectTypeOf<ReturnType<TenantImageStore['forTenant']>>().toEqualTypeOf<ImageStore>();
    expectTypeOf<ReturnType<ImageStore['put']>>().toEqualTypeOf<Promise<ImageRef>>();
  });
});
