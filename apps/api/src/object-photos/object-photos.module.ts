import { Module } from '@nestjs/common';
import { ObjectPhotosController } from './object-photos.controller';
import { ObjectPhotosService } from './object-photos.service';

@Module({ controllers: [ObjectPhotosController], providers: [ObjectPhotosService], exports: [ObjectPhotosService] })
export class ObjectPhotosModule {}
