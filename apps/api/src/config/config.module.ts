import { Global, Module } from '@nestjs/common';
import { AppEnv, loadEnv } from './env';

/** Injection token for the typed environment. */
export const APP_ENV = Symbol('APP_ENV');

@Global()
@Module({
  providers: [{ provide: APP_ENV, useFactory: (): AppEnv => loadEnv() }],
  exports: [APP_ENV],
})
export class AppConfigModule {}
