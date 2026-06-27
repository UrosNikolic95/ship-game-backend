import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from 'typeorm';
import { BoatForSaleEntity } from './boat-for-sale.entity';

// A port in the shared world. The integer `id` is the primary key, and the game
// refers to a port by that id (as a string) in the client API. Per-resource base
// prices are stored as columns; the hulls the port's shipyard sells live in the
// `boat_for_sale` table, related back here.
@Entity('ports')
export class PortEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column('double precision')
  x: number;

  @Column('double precision')
  y: number;

  @Column('int')
  priceWood: number;

  @Column('int')
  priceGrain: number;

  @Column('int')
  priceIron: number;

  @Column('int')
  priceSpice: number;

  @Column('int')
  priceCloth: number;

  // Cascaded and eager so a port loads and saves together with the rows listing
  // the hulls its shipyard sells.
  @OneToMany(() => BoatForSaleEntity, (b) => b.port, {
    cascade: true,
    eager: true,
  })
  boatsForSale: BoatForSaleEntity[];
}
