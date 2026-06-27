import { Entity, ManyToOne, PrimaryGeneratedColumn, Unique } from 'typeorm';
import { PortEntity } from './port.entity';
import { BoatTypeEntity } from './boat-type.entity';

// Which boat types a port's shipyard offers for sale. Each row links one port to
// one boat type it sells, so a port with a shipyard has one row per hull on
// offer and a port without a shipyard has none.
@Entity('boat_for_sale')
@Unique(['port', 'boatType'])
export class BoatForSaleEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => PortEntity, (port) => port.boatsForSale, {
    onDelete: 'CASCADE',
  })
  port: PortEntity;

  @ManyToOne(() => BoatTypeEntity, { eager: true })
  boatType: BoatTypeEntity;
}
