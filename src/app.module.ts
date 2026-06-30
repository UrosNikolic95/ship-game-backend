import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GameModule } from './game/game.module';
import { WorldChunkEntity } from './game/entities/world-chunk.entity';
import { PortEntity } from './game/entities/port.entity';
import { ShipEntity } from './game/entities/ship.entity';
import { ShipInventoryEntity } from './game/entities/ship-inventory.entity';
import { PurchaseEntity } from './game/entities/purchase.entity';
import { BoatTypeEntity } from './game/entities/boat-type.entity';
import { BoatForSaleEntity } from './game/entities/boat-for-sale.entity';

@Module({
  imports: [
    // Load the PostgreSQL connection settings from the .env file. See .env.example.
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST', 'localhost'),
        port: parseInt(config.get<string>('DB_PORT', '5432'), 10),
        username: config.get<string>('DB_USER'),
        password: config.get<string>('DB_PASSWORD'),
        database: config.get<string>('DB_NAME'),
        autoLoadEntities: true,
        // Auto-create/update tables on startup when DB_SYNCHRONIZE=true.
        synchronize: config.get<string>('DB_SYNCHRONIZE', 'false') === 'true',
      }),
    }),
    GameModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
