import { Controller, Get } from '@nestjs/common';
import { Public } from './access/decorators';

@Controller('health')
export class HealthController {
  @Public() @Get()
  check(): { ok: true } {
    return { ok: true };
  }
}
