import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CasService } from './cas/cas.service';
import { CasLoginStateService } from './cas/cas-login-state.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, CasService, CasLoginStateService],
  exports: [AuthService],
})
export class AuthModule {}
