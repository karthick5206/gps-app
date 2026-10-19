import { Controller, Get, Header } from '@nestjs/common';
import { Public } from '../access/decorators';
import { buildOpenApi } from './openapi';

/** OpenAPI 3 description of the public API; no key needed so tools can import it. */
@Controller('v1')
export class OpenApiController {
  private readonly doc = buildOpenApi(process.env.PUBLIC_API_URL ?? '/api');

  @Get('openapi.json') @Public() @Header('Cache-Control', 'public, max-age=300')
  spec() {
    return this.doc;
  }
}
