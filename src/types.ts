export type SupplierId = 'A' | 'B';

export const SUPPLIER_IDS: readonly SupplierId[] = ['A', 'B'] as const;

export type SupplierLabel = 'Supplier A' | 'Supplier B';

export const supplierLabel = (id: SupplierId): SupplierLabel => `Supplier ${id}`;

/** Shape returned by a supplier API. */
export interface SupplierHotel {
  hotelId: string;
  name: string;
  price: number;
  city: string;
  commissionPct: number;
}

/** Shape returned to clients and stored in Redis. */
export interface HotelOffer {
  name: string;
  price: number;
  supplier: SupplierLabel;
  commissionPct: number;
}

export interface HotelOffersWorkflowInput {
  city: string;
  requestId?: string;
}

export interface HotelOffersWorkflowResult {
  city: string;
  hotels: HotelOffer[];
  degradedSuppliers: SupplierId[];
}
