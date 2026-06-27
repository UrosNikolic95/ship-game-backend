import {
  Column,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { ShipEntity } from './ship.entity';

// How much of one resource a ship is carrying. One row per (ship, resource), so
// a ship has five rows — one for each tradeable good.
@Entity('ship_inventory')
@Unique(['ship', 'resource'])
export class ShipInventoryEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => ShipEntity, (ship) => ship.inventory, {
    onDelete: 'CASCADE',
  })
  ship: ShipEntity;

  @Column()
  resource: string;

  @Column('int')
  quantity: number;
}
