/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License;
 * you may not use this file except in compliance with the Elastic License.
 */

import {
  FrameworkRequest,
  FrameworkWrappableRequest,
} from '../lib/adapters/framework/adapter_types';

export const internalAuthData = Symbol('internalAuthData');

export function wrapRequest<InternalRequest extends FrameworkWrappableRequest>(
  req: InternalRequest
): FrameworkRequest<InternalRequest> {
  const { params, payload, query, headers, info } = req;

  const isAuthenticated = headers.authorization != null;

  return {
    user: isAuthenticated
      ? {
          kind: 'authenticated',
          [internalAuthData]: headers,
        }
      : {
          kind: 'unauthenticated',
        },
    headers,
    info,
    params,
    payload,
    query,
  };
}