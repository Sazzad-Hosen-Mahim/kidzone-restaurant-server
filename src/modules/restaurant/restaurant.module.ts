import { Module } from '@nestjs/common';
import { CustomersModule } from '@modules/customers/customers.module';
import { SequenceService } from '@common/services/sequence.service';
import { MenuService } from './menu/menu.service';
import { OrdersService } from './orders/orders.service';
import { MenuController, OrdersController } from './restaurant.controller';

@Module({
  imports: [CustomersModule],
  controllers: [MenuController, OrdersController],
  providers: [MenuService, OrdersService, SequenceService],
  exports: [MenuService, OrdersService],
})
export class RestaurantModule {}
