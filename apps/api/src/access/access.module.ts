import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { JwtAuthGuard } from './auth.guard';
import { AuthContextService } from './auth-context.service';
import { PermissionGuard } from './permission.guard';

@Global()
@Module({
  imports: [JwtModule.register({})],
  providers: [
    AuthContextService,
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  exports: [AuthContextService, JwtModule],
})
export class AccessModule {}
