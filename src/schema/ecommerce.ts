// "Demo": a mid-sized shop database with a few planted problems for the
// agent's audit to find — unindexed foreign keys (inventory.variant_id,
// payments.order_id, events.user_id, order_items.variant_id), a God table
// (orders, with its shipping_/billing_/gift_ column groups) and an orphaned
// table (legacy_import_log).

import { col, fk, idx, pk, type SchemaDef } from './types';

const ts = (name: string, nullable = false) => col(name, 'timestamptz', { nullable });

export const ecommerce: SchemaDef = {
  id: 'demo',
  name: 'Demo · Storefront',
  engine: 'PostgreSQL 16 · mock',
  description: 'An online shop: accounts, catalog, orders, payments, fulfilment and analytics.',
  domains: [
    { id: 'identity', label: 'Identity', color: '#38bdf8' },
    { id: 'catalog', label: 'Catalog', color: '#a78bfa' },
    { id: 'orders', label: 'Orders', color: '#f472b6' },
    { id: 'payments', label: 'Payments', color: '#34d399' },
    { id: 'fulfilment', label: 'Fulfilment', color: '#fbbf24' },
    { id: 'analytics', label: 'Analytics', color: '#fb923c' },
  ],
  tables: [
    // ── identity ──
    {
      name: 'users',
      domain: 'identity',
      rows: 184_000,
      columns: [pk(), col('email', 'varchar(255)', { unique: true }), col('password_hash', 'varchar(72)'), col('full_name', 'varchar(120)'), col('status', 'varchar(16)'), ts('created_at'), ts('last_login_at', true)],
      fks: [],
      indexes: [idx('users', ['email'], true), idx('users', ['created_at'])],
    },
    {
      name: 'user_profiles',
      domain: 'identity',
      rows: 171_000,
      columns: [pk(), col('user_id', 'bigint', { unique: true }), col('avatar_url', 'text', { nullable: true }), col('locale', 'varchar(8)'), col('timezone', 'varchar(40)'), col('marketing_opt_in', 'boolean')],
      fks: [fk('user_id', 'users')],
      indexes: [idx('user_profiles', ['user_id'], true)],
    },
    {
      name: 'addresses',
      domain: 'identity',
      rows: 263_000,
      columns: [pk(), col('user_id', 'bigint'), col('label', 'varchar(40)'), col('line1', 'varchar(160)'), col('line2', 'varchar(160)', { nullable: true }), col('city', 'varchar(80)'), col('region', 'varchar(80)'), col('postal_code', 'varchar(16)'), col('country', 'char(2)')],
      fks: [fk('user_id', 'users')],
      indexes: [idx('addresses', ['user_id'])],
    },
    {
      name: 'sessions',
      domain: 'identity',
      rows: 1_920_000,
      columns: [pk('id', 'uuid'), col('user_id', 'bigint'), col('ip', 'inet'), col('user_agent', 'text'), ts('created_at'), ts('expires_at')],
      fks: [fk('user_id', 'users')],
      indexes: [idx('sessions', ['user_id']), idx('sessions', ['expires_at'])],
    },
    {
      name: 'roles',
      domain: 'identity',
      rows: 6,
      columns: [pk('id', 'smallint'), col('name', 'varchar(40)', { unique: true }), col('description', 'text', { nullable: true })],
      fks: [],
      indexes: [idx('roles', ['name'], true)],
    },
    {
      name: 'user_roles',
      domain: 'identity',
      rows: 190_500,
      columns: [col('user_id', 'bigint', { pk: true }), col('role_id', 'smallint', { pk: true }), ts('granted_at')],
      fks: [fk('user_id', 'users'), fk('role_id', 'roles')],
      indexes: [idx('user_roles', ['role_id'])],
    },
    // ── catalog ──
    {
      name: 'brands',
      domain: 'catalog',
      rows: 420,
      columns: [pk(), col('name', 'varchar(120)', { unique: true }), col('country', 'char(2)'), col('website', 'text', { nullable: true })],
      fks: [],
      indexes: [idx('brands', ['name'], true)],
    },
    {
      name: 'categories',
      domain: 'catalog',
      rows: 310,
      columns: [pk(), col('parent_id', 'bigint', { nullable: true }), col('name', 'varchar(120)'), col('slug', 'varchar(140)', { unique: true }), col('position', 'integer')],
      fks: [fk('parent_id', 'categories')],
      indexes: [idx('categories', ['parent_id']), idx('categories', ['slug'], true)],
    },
    {
      name: 'products',
      domain: 'catalog',
      rows: 42_800,
      columns: [pk(), col('brand_id', 'bigint'), col('name', 'varchar(200)'), col('slug', 'varchar(220)', { unique: true }), col('description', 'text'), col('status', 'varchar(16)'), ts('created_at'), ts('updated_at')],
      fks: [fk('brand_id', 'brands')],
      indexes: [idx('products', ['brand_id']), idx('products', ['slug'], true)],
    },
    {
      name: 'product_categories',
      domain: 'catalog',
      rows: 96_400,
      columns: [col('product_id', 'bigint', { pk: true }), col('category_id', 'bigint', { pk: true })],
      fks: [fk('product_id', 'products'), fk('category_id', 'categories')],
      indexes: [idx('product_categories', ['category_id'])],
    },
    {
      name: 'product_variants',
      domain: 'catalog',
      rows: 133_000,
      columns: [pk(), col('product_id', 'bigint'), col('sku', 'varchar(64)', { unique: true }), col('title', 'varchar(160)'), col('price_cents', 'integer'), col('currency', 'char(3)'), col('weight_grams', 'integer', { nullable: true })],
      fks: [fk('product_id', 'products')],
      indexes: [idx('product_variants', ['product_id']), idx('product_variants', ['sku'], true)],
    },
    {
      name: 'inventory',
      domain: 'catalog',
      rows: 398_000,
      // variant_id has no index: every stock check scans the table
      columns: [pk(), col('variant_id', 'bigint'), col('warehouse_id', 'bigint'), col('on_hand', 'integer'), col('reserved', 'integer'), ts('updated_at')],
      fks: [fk('variant_id', 'product_variants'), fk('warehouse_id', 'warehouses')],
      indexes: [idx('inventory', ['warehouse_id'])],
    },
    // ── orders ──
    {
      name: 'carts',
      domain: 'orders',
      rows: 612_000,
      columns: [pk(), col('user_id', 'bigint', { nullable: true }), col('session_id', 'uuid', { nullable: true }), col('coupon_id', 'bigint', { nullable: true }), col('status', 'varchar(16)'), ts('created_at'), ts('updated_at')],
      fks: [fk('user_id', 'users'), fk('session_id', 'sessions'), fk('coupon_id', 'coupons')],
      indexes: [idx('carts', ['user_id']), idx('carts', ['session_id']), idx('carts', ['coupon_id'])],
    },
    {
      name: 'cart_items',
      domain: 'orders',
      rows: 1_740_000,
      columns: [pk(), col('cart_id', 'bigint'), col('variant_id', 'bigint'), col('quantity', 'integer'), col('unit_price_cents', 'integer'), ts('added_at')],
      fks: [fk('cart_id', 'carts'), fk('variant_id', 'product_variants')],
      indexes: [idx('cart_items', ['cart_id']), idx('cart_items', ['variant_id'])],
    },
    {
      name: 'coupons',
      domain: 'orders',
      rows: 1_250,
      columns: [pk(), col('code', 'varchar(32)', { unique: true }), col('discount_type', 'varchar(12)'), col('discount_value', 'integer'), ts('starts_at'), ts('ends_at', true), col('max_redemptions', 'integer', { nullable: true })],
      fks: [],
      indexes: [idx('coupons', ['code'], true)],
    },
    {
      name: 'orders',
      domain: 'orders',
      rows: 2_310_000,
      comment: 'Grew column by column since v1: shipping, billing and gift details all live here.',
      columns: [
        pk(),
        col('user_id', 'bigint'),
        col('cart_id', 'bigint', { nullable: true }),
        col('coupon_id', 'bigint', { nullable: true }),
        col('number', 'varchar(20)', { unique: true }),
        col('status', 'varchar(16)'),
        col('currency', 'char(3)'),
        col('subtotal_cents', 'integer'),
        col('discount_cents', 'integer'),
        col('tax_cents', 'integer'),
        col('total_cents', 'integer'),
        col('shipping_name', 'varchar(120)'),
        col('shipping_phone', 'varchar(32)', { nullable: true }),
        col('shipping_line1', 'varchar(160)'),
        col('shipping_line2', 'varchar(160)', { nullable: true }),
        col('shipping_city', 'varchar(80)'),
        col('shipping_region', 'varchar(80)'),
        col('shipping_postal_code', 'varchar(16)'),
        col('shipping_country', 'char(2)'),
        col('billing_name', 'varchar(120)'),
        col('billing_line1', 'varchar(160)'),
        col('billing_line2', 'varchar(160)', { nullable: true }),
        col('billing_city', 'varchar(80)'),
        col('billing_region', 'varchar(80)'),
        col('billing_postal_code', 'varchar(16)'),
        col('billing_country', 'char(2)'),
        col('billing_vat_number', 'varchar(32)', { nullable: true }),
        col('gift_message', 'text', { nullable: true }),
        col('gift_wrap', 'boolean'),
        col('gift_recipient_email', 'varchar(255)', { nullable: true }),
        col('notes', 'text', { nullable: true }),
        col('source', 'varchar(24)'),
        ts('placed_at'),
        ts('cancelled_at', true),
        ts('updated_at'),
      ],
      fks: [fk('user_id', 'users'), fk('cart_id', 'carts'), fk('coupon_id', 'coupons')],
      indexes: [idx('orders', ['user_id']), idx('orders', ['cart_id']), idx('orders', ['coupon_id']), idx('orders', ['number'], true), idx('orders', ['placed_at'])],
    },
    {
      name: 'order_items',
      domain: 'orders',
      rows: 6_480_000,
      // variant_id has no index: "who bought this variant" scans 6.5M rows
      columns: [pk(), col('order_id', 'bigint'), col('variant_id', 'bigint'), col('quantity', 'integer'), col('unit_price_cents', 'integer'), col('tax_cents', 'integer')],
      fks: [fk('order_id', 'orders'), fk('variant_id', 'product_variants')],
      indexes: [idx('order_items', ['order_id'])],
    },
    // ── payments ──
    {
      name: 'payment_methods',
      domain: 'payments',
      rows: 142_000,
      columns: [pk(), col('user_id', 'bigint'), col('provider', 'varchar(24)'), col('brand', 'varchar(24)'), col('last4', 'char(4)'), col('exp_month', 'smallint'), col('exp_year', 'smallint'), col('token', 'varchar(120)', { unique: true })],
      fks: [fk('user_id', 'users')],
      indexes: [idx('payment_methods', ['user_id']), idx('payment_methods', ['token'], true)],
    },
    {
      name: 'payments',
      domain: 'payments',
      rows: 2_450_000,
      // order_id has no index: loading an order's payments scans the table
      columns: [pk(), col('order_id', 'bigint'), col('payment_method_id', 'bigint', { nullable: true }), col('provider_ref', 'varchar(80)'), col('amount_cents', 'integer'), col('currency', 'char(3)'), col('status', 'varchar(16)'), ts('captured_at', true), ts('created_at')],
      fks: [fk('order_id', 'orders'), fk('payment_method_id', 'payment_methods')],
      indexes: [idx('payments', ['payment_method_id']), idx('payments', ['created_at'])],
    },
    {
      name: 'refunds',
      domain: 'payments',
      rows: 71_300,
      columns: [pk(), col('payment_id', 'bigint'), col('amount_cents', 'integer'), col('reason', 'varchar(40)'), col('status', 'varchar(16)'), ts('created_at')],
      fks: [fk('payment_id', 'payments')],
      indexes: [idx('refunds', ['payment_id'])],
    },
    // ── fulfilment ──
    {
      name: 'warehouses',
      domain: 'fulfilment',
      rows: 14,
      columns: [pk(), col('code', 'varchar(12)', { unique: true }), col('name', 'varchar(80)'), col('city', 'varchar(80)'), col('country', 'char(2)')],
      fks: [],
      indexes: [idx('warehouses', ['code'], true)],
    },
    {
      name: 'carriers',
      domain: 'fulfilment',
      rows: 9,
      columns: [pk(), col('name', 'varchar(60)', { unique: true }), col('tracking_url', 'text')],
      fks: [],
      indexes: [idx('carriers', ['name'], true)],
    },
    {
      name: 'shipments',
      domain: 'fulfilment',
      rows: 2_190_000,
      columns: [pk(), col('order_id', 'bigint'), col('warehouse_id', 'bigint'), col('carrier_id', 'bigint'), col('tracking_number', 'varchar(64)'), col('status', 'varchar(16)'), ts('shipped_at', true), ts('delivered_at', true)],
      fks: [fk('order_id', 'orders'), fk('warehouse_id', 'warehouses'), fk('carrier_id', 'carriers')],
      indexes: [idx('shipments', ['order_id']), idx('shipments', ['warehouse_id']), idx('shipments', ['carrier_id'])],
    },
    // ── analytics ──
    {
      name: 'reviews',
      domain: 'analytics',
      rows: 318_000,
      columns: [pk(), col('product_id', 'bigint'), col('user_id', 'bigint'), col('rating', 'smallint'), col('title', 'varchar(160)'), col('body', 'text'), ts('created_at')],
      fks: [fk('product_id', 'products'), fk('user_id', 'users')],
      indexes: [idx('reviews', ['product_id']), idx('reviews', ['user_id'])],
    },
    {
      name: 'events',
      domain: 'analytics',
      rows: 48_200_000,
      // user_id has no index, on the largest table in the database
      columns: [pk(), col('user_id', 'bigint', { nullable: true }), col('session_id', 'uuid', { nullable: true }), col('name', 'varchar(60)'), col('properties', 'jsonb'), ts('occurred_at')],
      fks: [fk('user_id', 'users'), fk('session_id', 'sessions')],
      indexes: [idx('events', ['session_id']), idx('events', ['occurred_at'])],
    },
    {
      name: 'legacy_import_log',
      domain: 'analytics',
      rows: 88_000,
      comment: 'Left over from the 2019 platform migration. Nothing references it.',
      columns: [pk(), col('source_file', 'varchar(200)'), col('row_number', 'integer'), col('payload', 'text'), col('error', 'text', { nullable: true }), ts('imported_at')],
      fks: [],
      indexes: [],
    },
  ],
  presets: [
    {
      id: 'checkout',
      label: 'Checkout: cart → stock → buyer',
      sql: `SELECT c.id, u.email, p.name, pv.sku, ci.quantity, i.on_hand
FROM carts c
JOIN users u ON u.id = c.user_id
JOIN cart_items ci ON ci.cart_id = c.id
JOIN product_variants pv ON pv.id = ci.variant_id
JOIN products p ON p.id = pv.product_id
JOIN inventory i ON i.variant_id = pv.id
WHERE c.id = 48213`,
    },
    {
      id: 'order_history',
      label: 'Order history with payments',
      sql: `SELECT o.number, o.total_cents, pay.status, s.tracking_number
FROM users u
JOIN orders o ON o.user_id = u.id
JOIN payments pay ON pay.order_id = o.id
JOIN shipments s ON s.order_id = o.id
WHERE u.email = 'ada@example.com'`,
    },
    {
      id: 'top_products',
      label: 'Best-selling products by brand',
      sql: `SELECT b.name, p.name, SUM(oi.quantity)
FROM order_items oi
JOIN product_variants pv ON pv.id = oi.variant_id
JOIN products p ON p.id = pv.product_id
JOIN brands b ON b.id = p.brand_id
WHERE b.name = 'Northwind'
GROUP BY b.name, p.name`,
    },
  ],
};
