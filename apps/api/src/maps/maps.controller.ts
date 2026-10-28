import { Controller, Get } from '@nestjs/common';
import { MapsConfigDto } from '@veetracer/shared';

/**
 * Optional basemaps for the map type switcher. Satellite: Esri World Imagery (ArcGIS Location Platform, env
 * ESRI_BASEMAP_KEY, a key scoped to basemaps only). The key ends up in tile URLs on the client, which is how Esri
 * basemap keys are meant to be used; null when not configured (the apps then hide Satellite).
 */
@Controller('maps')
export class MapsController {
  private readonly esriKey = process.env.ESRI_BASEMAP_KEY?.trim() ?? '';

  @Get('config')
  config(): MapsConfigDto {
    return {
      satellite: this.esriKey
        ? {
            tiles: [`https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=${encodeURIComponent(this.esriKey)}`],
            attribution: 'Powered by Esri · Esri, Maxar, Earthstar Geographics, and the GIS User Community',
            maxZoom: 19,
          }
        : null,
    };
  }
}
