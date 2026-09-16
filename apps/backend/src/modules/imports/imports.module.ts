import { Module } from '@nestjs/common';
import { GradesModule } from '../grades/grades.controller';
import { StudentsModule } from '../students/students.controller';
import { ImportsController } from './imports.controller';
import { RegistrationImportService } from './registration-import.service';

@Module({
  imports: [StudentsModule, GradesModule],
  controllers: [ImportsController],
  providers: [RegistrationImportService],
})
export class ImportsModule {}
