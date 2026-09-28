import { Child, Customer, Gender, Role } from '@prisma/client';
import { ageInYears, fromDateColumn } from '@common/utils/date.util';

/**
 * Role-aware serialisation of customer and child records.
 *
 * Child personal data — full name, date of birth, medical notes, emergency
 * contact — is Kid Zone data and must never reach a restaurant cashier, not
 * through a direct read and not through a relation on an order or a customer
 * lookup. Rather than trusting every query to remember, the shaping happens
 * here and every endpoint that returns a child goes through it.
 *
 * A cashier attaching a customer to a restaurant bill still needs to know the
 * guardian exists and how many children are on file, so they get a count and
 * nothing more.
 */

export interface PublicChildView {
  id: string;
  customerId: string;
  name: string;
  dateOfBirth: string;
  ageYears: number;
  gender: Gender | null;
  medicalNotes: string | null;
  emergencyContactName: string;
  emergencyContactPhone: string;
  isActive: boolean;
  createdAt: Date;
}

export interface RedactedChildView {
  id: string;
  customerId: string;
  /** Deliberately withheld from restaurant staff. */
  redacted: true;
}

export type ChildView = PublicChildView | RedactedChildView;

export function canSeeChildData(role: Role): boolean {
  return role === Role.ADMIN || role === Role.KIDZONE_MANAGER;
}

export function serializeChild(child: Child, role: Role, today?: string): ChildView {
  if (!canSeeChildData(role)) {
    return { id: child.id, customerId: child.customerId, redacted: true };
  }

  const dateOfBirth = fromDateColumn(child.dateOfBirth);

  return {
    id: child.id,
    customerId: child.customerId,
    name: child.name,
    dateOfBirth,
    ageYears: ageInYears(dateOfBirth, today ?? new Date()),
    gender: child.gender,
    medicalNotes: child.medicalNotes,
    emergencyContactName: child.emergencyContactName,
    emergencyContactPhone: child.emergencyContactPhone,
    isActive: child.isActive,
    createdAt: child.createdAt,
  };
}

export interface CustomerView {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  childCount?: number;
  children?: ChildView[];
}

export function serializeCustomer(
  customer: Customer & { children?: Child[]; _count?: { children: number } },
  role: Role,
  today?: string,
): CustomerView {
  const base: CustomerView = {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    address: customer.address,
    notes: customer.notes,
    isActive: customer.isActive,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
  };

  if (customer._count) {
    base.childCount = customer._count.children;
  }

  if (customer.children) {
    base.childCount = customer.children.length;
    // Restaurant staff get the count, never the children themselves.
    if (canSeeChildData(role)) {
      base.children = customer.children.map((child) => serializeChild(child, role, today));
    }
  }

  return base;
}
