/**
 * 出货单行（列表行与详情行同一形状）。
 *
 * 真源：`backend/worker/src/ws_shipments.py` 的 `_row_to_shipment`
 * （列表 `GET /shipments` 与详情 `GET /shipments/{id}` 都返回这份 17 键）。
 * 前端只声明要用的字段；后端多给的键不在这里出现（避免"以为有、其实是 undefined"）。
 */
export interface ShipmentRow {
  id: number;
  shipment_no: string;
  order_id: number | null;
  customer_name: string | null;
  consignee: string | null;
  cargo_desc: string | null;
  bl_no: string | null;
  bl_type: string | null;
  pol_name: string | null;
  pod_name: string | null;
  vessel: string | null;
  voyage: string | null;
  container_no: string | null;
  etd: string | null;
  eta: string | null;
  status: string;
  /** 货代/运费备注（详情与列表同键；编辑白名单里可改） */
  freight_remark?: string | null;
}
