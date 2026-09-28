import { describe, expect, it } from 'vitest';

import {
  ADD_ON_CATALOG,
  AddOnCode,
  CONCURRENCY_BOOST_CALLS_PER_UNIT,
  CURRENCY_MINOR_UNIT_EXPONENT,
  FeatureKey,
  LOCATION_SCOPABLE_ROLES,
  PLAN_CATALOG,
  PLATFORM_PERMISSIONS_REQUIRING_SUPPORT_GRANT,
  PLATFORM_ROLE_PERMISSIONS,
  PRICING_VERSION,
  Permission,
  PlanCode,
  PlatformPermission,
  PlatformRole,
  ROLE_PERMISSIONS,
  Role,
  enumValues,
  planIncludesFeature,
  planPriceForMarket,
  platformRoleHasPermission,
  roleHasPermission,
} from '../src/index.js';

describe('workspace RBAC matrix', () => {
  it('grants the owner every workspace permission', () => {
    expect([...ROLE_PERMISSIONS.OWNER].sort()).toEqual([...enumValues(Permission)].sort());
  });

  it('only references known permissions without duplicates', () => {
    const known = new Set<string>(enumValues(Permission));
    for (const role of enumValues(Role)) {
      const granted = ROLE_PERMISSIONS[role];
      expect(new Set(granted).size, role).toBe(granted.length);
      for (const permission of granted) {
        expect(known.has(permission), `${role} ${permission}`).toBe(true);
      }
    }
  });

  it('grants every permission to at least one role', () => {
    const granted = new Set(enumValues(Role).flatMap((role) => ROLE_PERMISSIONS[role]));
    for (const permission of enumValues(Permission)) {
      expect(granted.has(permission), permission).toBe(true);
    }
  });

  it('keeps billing members away from call content and contacts', () => {
    for (const permission of ROLE_PERMISSIONS.BILLING) {
      expect(
        permission.startsWith('calls:') || permission.startsWith('contacts:'),
        permission,
      ).toBe(false);
    }
  });

  it('keeps developers away from billing and security', () => {
    for (const permission of ROLE_PERMISSIONS.DEVELOPER) {
      expect(
        /^(billing|invoices|security|audit_logs|members|roles):/.test(permission),
        permission,
      ).toBe(false);
    }
  });

  it('keeps analysts and viewers read-only', () => {
    for (const role of ['ANALYST', 'VIEWER'] as const) {
      for (const permission of ROLE_PERMISSIONS[role]) {
        expect(permission.endsWith(':read'), `${role} ${permission}`).toBe(true);
      }
    }
    expect(roleHasPermission('ANALYST', 'calls:read_transcript')).toBe(false);
  });

  it('reserves destructive workspace operations for the owner', () => {
    for (const role of enumValues(Role).filter((candidate) => candidate !== 'OWNER')) {
      expect(roleHasPermission(role, 'workspace:cancel'), role).toBe(false);
      expect(roleHasPermission(role, 'members:manage'), role).toBe(false);
      expect(roleHasPermission(role, 'security:manage'), role).toBe(false);
      expect(roleHasPermission(role, 'retention:manage'), role).toBe(false);
    }
    expect(roleHasPermission('BILLING', 'billing:manage')).toBe(true);
    expect(roleHasPermission('OPERATOR', 'calls:transfer')).toBe(true);
    expect(LOCATION_SCOPABLE_ROLES).toContain('OPERATOR');
  });
});

describe('platform RBAC matrix', () => {
  it('grants platform admins everything and validates all grants', () => {
    expect([...PLATFORM_ROLE_PERMISSIONS.PLATFORM_ADMIN].sort()).toEqual(
      [...enumValues(PlatformPermission)].sort(),
    );
    const known = new Set<string>(enumValues(PlatformPermission));
    for (const role of enumValues(PlatformRole)) {
      for (const permission of PLATFORM_ROLE_PERMISSIONS[role]) {
        expect(known.has(permission)).toBe(true);
      }
    }
  });

  it('restricts sensitive content, kill switches and refunds', () => {
    expect(platformRoleHasPermission('SUPPORT_AGENT', 'platform.sensitive_content:read')).toBe(
      false,
    );
    expect(platformRoleHasPermission('SUPPORT_AGENT', 'platform.kill_switches:manage')).toBe(false);
    expect(platformRoleHasPermission('PLATFORM_OPS', 'platform.kill_switches:manage')).toBe(true);
    expect(platformRoleHasPermission('FINANCE_OPS', 'platform.refunds:approve')).toBe(true);
    expect(platformRoleHasPermission('SUPPORT_LEAD', 'platform.refunds:approve')).toBe(false);
    expect(PLATFORM_PERMISSIONS_REQUIRING_SUPPORT_GRANT).toEqual([
      'platform.sensitive_content:read',
    ]);
  });
});

describe('plan catalog', () => {
  it('matches the v6 HUF price book in integer minor units', () => {
    expect(PRICING_VERSION).toBe('2026-09-11.v6');
    expect(CURRENCY_MINOR_UNIT_EXPONENT.HUF).toBe(2);
    const expected = {
      START: { monthly: 3_990_000, overage: 14_900, seconds: 9_000, concurrency: 2 },
      BUSINESS: { monthly: 6_990_000, overage: 12_900, seconds: 24_000, concurrency: 10 },
      PRO: { monthly: 12_990_000, overage: 10_900, seconds: 60_000, concurrency: 50 },
    } as const;
    for (const [code, values] of Object.entries(expected)) {
      const plan = PLAN_CATALOG[code as keyof typeof expected];
      const price = planPriceForMarket(plan, 'HU');
      expect(price).toEqual({
        market: 'HU',
        currency: 'HUF',
        monthlyNetMinor: values.monthly,
        overagePerMinuteNetMinor: values.overage,
      });
      expect(plan.includedVoiceSeconds).toBe(values.seconds);
      expect(plan.concurrentCalls).toBe(values.concurrency);
      expect(plan.contractDefined).toBe(false);
      expect(Number.isSafeInteger(values.monthly)).toBe(true);
    }
  });

  it('models enterprise as contract defined with at least 100 concurrent calls', () => {
    const enterprise = PLAN_CATALOG.ENTERPRISE;
    expect(enterprise.contractDefined).toBe(true);
    expect(enterprise.prices).toEqual([]);
    expect(enterprise.includedVoiceSeconds).toBeNull();
    expect(enterprise.concurrentCalls).toBeGreaterThanOrEqual(100);
    expect(planPriceForMarket(enterprise, 'HU')).toBeNull();
  });

  it('does not ship an EUR price book until it is approved', () => {
    for (const code of enumValues(PlanCode)) {
      expect(planPriceForMarket(PLAN_CATALOG[code], 'INTERNATIONAL'), code).toBeNull();
    }
  });

  it('keeps plan features nested and concurrency monotonic', () => {
    const order = ['START', 'BUSINESS', 'PRO', 'ENTERPRISE'] as const;
    for (let index = 1; index < order.length; index += 1) {
      const previous = PLAN_CATALOG[order[index - 1] ?? 'START'];
      const current = PLAN_CATALOG[order[index] ?? 'START'];
      for (const feature of previous.features) {
        expect(planIncludesFeature(current, feature), `${current.code} ${feature}`).toBe(true);
      }
      expect(current.concurrentCalls).toBeGreaterThan(previous.concurrentCalls);
    }
    expect(planIncludesFeature(PLAN_CATALOG.START, 'booking_engine')).toBe(false);
    expect(planIncludesFeature(PLAN_CATALOG.BUSINESS, 'booking_engine')).toBe(true);
    for (const code of enumValues(PlanCode)) {
      const plan = PLAN_CATALOG[code];
      expect(new Set(plan.features).size).toBe(plan.features.length);
      expect(plan.maxCallDurationSeconds).toBe(1_800);
    }
  });
});

describe('add-on catalog', () => {
  it('defines every add-on with valid plans and features', () => {
    const plans = new Set<string>(enumValues(PlanCode));
    const features = new Set<string>(enumValues(FeatureKey));
    for (const code of enumValues(AddOnCode)) {
      const definition = ADD_ON_CATALOG[code];
      expect(definition.code).toBe(code);
      expect(definition.availableFor.length).toBeGreaterThan(0);
      for (const plan of definition.availableFor) {
        expect(plans.has(plan)).toBe(true);
      }
      for (const feature of definition.grantsFeatures) {
        expect(features.has(feature)).toBe(true);
      }
    }
    expect(ADD_ON_CATALOG.CONCURRENCY_BOOST.stackable).toBe(true);
    expect(CONCURRENCY_BOOST_CALLS_PER_UNIT).toBeGreaterThan(0);
    expect(ADD_ON_CATALOG.EXTRA_LOCATION.availableFor).not.toContain('START');
  });
});
