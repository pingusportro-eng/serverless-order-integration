import { InMemoryOrderRepository } from '../../src/infrastructure/memory/in-memory-order-repository.js';
import { orderRepositoryContract } from './order-repository.contract.js';

orderRepositoryContract('InMemoryOrderRepository', () => new InMemoryOrderRepository());
