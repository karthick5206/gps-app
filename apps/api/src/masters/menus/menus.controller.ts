import { Controller, Get } from '@nestjs/common';
import { MenuDef, MENUS } from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { Auth } from '../../access/decorators';

/** Menu catalogue for building navigation and the role permission matrix (platform menus only for the Super Admin). */
@Controller('menus')
export class MenusController {
  @Get()
  list(@Auth() ctx: AuthContext): readonly MenuDef[] {
    return ctx.isSuperAdmin ? MENUS : MENUS.filter((m) => !m.superAdminOnly);
  }
}
