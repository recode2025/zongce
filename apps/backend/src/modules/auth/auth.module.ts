import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CasService } from './cas/cas.service';

@Module({
  controllers: [AuthController],
  providers: [AuthService, CasService],
  exports: [AuthService],
})
export class AuthModule {}
