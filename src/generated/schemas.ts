// GENERATED FILE — DO NOT EDIT, run npm run codegen
// Sources: scripts/hetzner-cloud.openapi.json (cloud), scripts/hetzner-api.openapi.json (hetzner)

/** A path or query parameter, as `describe_operation` renders it. */
export interface ParamSchema {
  name: string;
  in: 'path' | 'query';
  required?: boolean;
  description?: string;
  schema?: unknown;
}

/**
 * Dereferenced, pruned parameter and request-body schemas for one operation.
 * `body` is absent exactly when the operation takes no JSON body.
 */
export interface OperationSchema {
  params?: ParamSchema[];
  body?: unknown;
}

/** Keyed by operation id. An absent id takes neither parameters nor a body. */
export const SCHEMAS: Record<string, OperationSchema> = {
  get_actions: {
    params: [
      {
        name: 'id',
        in: 'query',
        required: true,
        description: 'Filter the actions by ID. May be used multiple times. The response will only contain actions matching the specified IDs.',
        schema: {
          type: 'array',
          items: {
            description: 'ID of the Action.',
            type: 'integer',
            format: 'int64',
            minimum: 1,
            maximum: 9007199254740991,
          },
        },
      },
    ],
  },
  get_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_certificates: {
    params: [
      {
        name: 'sort',
        in: 'query',
        description: 'Sort resources by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'name',
              'name:asc',
              'name:desc',
              'created',
              'created:asc',
              'created:desc',
            ],
          },
        },
      },
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'label_selector',
        in: 'query',
        description: 'Filter resources by labels. The response will only contain resources matching the label selector. For more information, see "Label Selector".',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'type',
        in: 'query',
        description: 'Filter resources by type. May be used multiple times. The response will only contain the resources with the specified type.',
        schema: {
          type: 'array',
          items: {
            description: 'Type of the Certificate.',
            type: 'string',
            enum: ['uploaded', 'managed'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  create_certificate: {
    body: {
      title: 'CreateCertificateRequest',
      type: 'object',
      properties: {
        name: {
          description: 'Name of the Certificate.',
          type: 'string',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
        type: {
          description: 'Choose between uploading a Certificate in PEM format or requesting a managed Let\'s Encrypt Certificate.',
          type: 'string',
          enum: ['uploaded', 'managed'],
          default: 'uploaded',
        },
        certificate: {
          description: 'Certificate and chain in PEM format, in order so that each record directly certifies the one preceding. Required for type uploaded Certificates.',
          type: 'string',
        },
        private_key: {
          description: 'Certificate key in PEM format. Required for type uploaded Certificates.',
          type: 'string',
        },
        domain_names: {
          description: 'Domains and subdomains that should be contained in the Certificate issued by Let\'s Encrypt. Required for type managed Certificates.',
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['name'],
    },
  },
  get_certificate: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Certificate.',
        schema: {
          description: 'ID of the Certificate.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  update_certificate: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Certificate.',
        schema: {
          description: 'ID of the Certificate.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'UpdateCertificateRequest',
      type: 'object',
      properties: {
        name: {
          description: 'New Certificate name.',
          type: 'string',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. Note that the set of Labels provided in the request will overwrite the existing one. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
    },
  },
  delete_certificate: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Certificate.',
        schema: {
          description: 'ID of the Certificate.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_certificate_actions: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Certificate.',
        schema: {
          description: 'ID of the Certificate.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_certificate_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Certificate.',
        schema: {
          description: 'ID of the Certificate.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'action_id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  retry_certificate: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Certificate.',
        schema: {
          description: 'ID of the Certificate.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_certificates_actions: {
    params: [
      {
        name: 'id',
        in: 'query',
        description: 'Filter the actions by ID. May be used multiple times. The response will only contain actions matching the specified IDs.',
        schema: {
          type: 'array',
          items: {
            description: 'ID of the Action.',
            type: 'integer',
            format: 'int64',
            minimum: 1,
            maximum: 9007199254740991,
          },
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_certificates_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_datacenters: {
    params: [
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort resources by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['id', 'id:asc', 'id:desc', 'name', 'name:asc', 'name:desc'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_datacenter: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Data Center.',
        schema: {
          description: 'ID of the Data Center.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_firewalls: {
    params: [
      {
        name: 'sort',
        in: 'query',
        description: 'Sort resources by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'name',
              'name:asc',
              'name:desc',
              'created',
              'created:asc',
              'created:desc',
            ],
          },
        },
      },
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'label_selector',
        in: 'query',
        description: 'Filter resources by labels. The response will only contain resources matching the label selector. For more information, see "Label Selector".',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  create_firewall: {
    body: {
      title: 'CreateFirewallRequest',
      type: 'object',
      properties: {
        name: {
          description: 'Name of the Firewall. Must be unique per Project.',
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
        rules: {
          description: 'Array of rules. Rules are limited to 50 entries per Firewall and 500 effective rules.',
          type: 'array',
          items: {
            title: 'Rule',
            type: 'object',
            properties: {
              description: {
                description: 'Description of the rule.',
                type: ['string', 'null'],
                maxLength: 255,
              },
              direction: {
                description: 'Traffic direction in which the rule should be applied to. Use sourceips for direction in and destinationips for direction out to specify IPs.',
                type: 'string',
                enum: ['in', 'out'],
              },
              source_ips: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
              destination_ips: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
              protocol: {
                description: 'Network protocol to apply the rule for.',
                type: 'string',
                enum: ['tcp', 'udp', 'icmp', 'esp', 'gre'],
              },
              port: {
                type: 'string',
              },
            },
            additionalProperties: false,
            required: ['direction', 'protocol'],
          },
        },
        apply_to: {
          description: 'Resources to apply the Firewall to. Resources added directly are taking precedence over those added via a Label Selector.',
          type: 'array',
          items: {
            title: 'FirewallResource',
            type: 'object',
            properties: {
              type: {
                description: 'Type of the resource.',
                type: 'string',
                enum: ['server', 'label_selector'],
              },
              server: {
                description: 'Server the Firewall is applied to. Only set for type server, otherwise null.',
                type: 'object',
                properties: {
                  id: {
                    description: 'ID of the Server.',
                    type: 'integer',
                    format: 'int64',
                  },
                },
                additionalProperties: false,
                required: ['id'],
              },
              label_selector: {
                description: 'Label Selector the Firewall is applied to. Only set for type labelselector, otherwise null.',
                type: 'object',
                properties: {
                  selector: {
                    description: 'The selector.',
                    type: 'string',
                  },
                },
                additionalProperties: false,
                required: ['selector'],
              },
            },
            additionalProperties: false,
            required: ['type'],
          },
        },
      },
      additionalProperties: false,
      required: ['name'],
    },
  },
  get_firewall: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Firewall.',
        schema: {
          description: 'ID of the Firewall.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  update_firewall: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Firewall.',
        schema: {
          description: 'ID of the Firewall.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'UpdateFirewallRequest',
      type: 'object',
      properties: {
        name: {
          description: 'Name of the Firewall. Must be unique per Project.',
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. Note that the set of Labels provided in the request will overwrite the existing one. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
      additionalProperties: false,
    },
  },
  delete_firewall: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Firewall.',
        schema: {
          description: 'ID of the Firewall.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_firewall_actions: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Firewall.',
        schema: {
          description: 'ID of the Firewall.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_firewall_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Firewall.',
        schema: {
          description: 'ID of the Firewall.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'action_id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  apply_firewall_to_resources: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Firewall.',
        schema: {
          description: 'ID of the Firewall.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'ApplyToResourcesRequest',
      type: 'object',
      properties: {
        apply_to: {
          description: 'Resources to apply the Firewall to. Extends existing resources.',
          type: 'array',
          items: {
            title: 'FirewallResource',
            type: 'object',
            properties: {
              type: {
                description: 'Type of the resource.',
                type: 'string',
                enum: ['server', 'label_selector'],
              },
              server: {
                description: 'Server the Firewall is applied to. Only set for type server, otherwise null.',
                type: 'object',
                properties: {
                  id: {
                    description: 'ID of the Server.',
                    type: 'integer',
                    format: 'int64',
                  },
                },
                additionalProperties: false,
                required: ['id'],
              },
              label_selector: {
                description: 'Label Selector the Firewall is applied to. Only set for type labelselector, otherwise null.',
                type: 'object',
                properties: {
                  selector: {
                    description: 'The selector.',
                    type: 'string',
                  },
                },
                additionalProperties: false,
                required: ['selector'],
              },
            },
            additionalProperties: false,
            required: ['type'],
          },
        },
      },
      additionalProperties: false,
      required: ['apply_to'],
    },
  },
  remove_firewall_from_resources: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Firewall.',
        schema: {
          description: 'ID of the Firewall.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'RemoveFromResourcesRequest',
      type: 'object',
      properties: {
        remove_from: {
          description: 'Resources to remove the Firewall from.',
          type: 'array',
          items: {
            title: 'FirewallResource',
            type: 'object',
            properties: {
              type: {
                description: 'Type of the resource.',
                type: 'string',
                enum: ['server', 'label_selector'],
              },
              server: {
                description: 'Server the Firewall is applied to. Only set for type server, otherwise null.',
                type: 'object',
                properties: {
                  id: {
                    description: 'ID of the Server.',
                    type: 'integer',
                    format: 'int64',
                  },
                },
                additionalProperties: false,
                required: ['id'],
              },
              label_selector: {
                description: 'Label Selector the Firewall is applied to. Only set for type labelselector, otherwise null.',
                type: 'object',
                properties: {
                  selector: {
                    description: 'The selector.',
                    type: 'string',
                  },
                },
                additionalProperties: false,
                required: ['selector'],
              },
            },
            additionalProperties: false,
            required: ['type'],
          },
        },
      },
      additionalProperties: false,
      required: ['remove_from'],
    },
  },
  set_firewall_rules: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Firewall.',
        schema: {
          description: 'ID of the Firewall.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'SetRulesRequest',
      type: 'object',
      properties: {
        rules: {
          description: 'Array of rules. Rules are limited to 50 entries per Firewall and 500 effective rules. Existing rules will be replaced.',
          type: 'array',
          items: {
            title: 'Rule',
            type: 'object',
            properties: {
              description: {
                description: 'Description of the rule.',
                type: ['string', 'null'],
                maxLength: 255,
              },
              direction: {
                description: 'Traffic direction in which the rule should be applied to. Use sourceips for direction in and destinationips for direction out to specify IPs.',
                type: 'string',
                enum: ['in', 'out'],
              },
              source_ips: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
              destination_ips: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
              protocol: {
                description: 'Network protocol to apply the rule for.',
                type: 'string',
                enum: ['tcp', 'udp', 'icmp', 'esp', 'gre'],
              },
              port: {
                type: 'string',
              },
            },
            additionalProperties: false,
            required: ['direction', 'protocol'],
          },
          maxItems: 50,
        },
      },
      additionalProperties: false,
      required: ['rules'],
    },
  },
  list_firewalls_actions: {
    params: [
      {
        name: 'id',
        in: 'query',
        description: 'Filter the actions by ID. May be used multiple times. The response will only contain actions matching the specified IDs.',
        schema: {
          type: 'array',
          items: {
            description: 'ID of the Action.',
            type: 'integer',
            format: 'int64',
            minimum: 1,
            maximum: 9007199254740991,
          },
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_firewalls_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_floating_ips: {
    params: [
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'label_selector',
        in: 'query',
        description: 'Filter resources by labels. The response will only contain resources matching the label selector. For more information, see "Label Selector".',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort resources by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'created',
              'created:asc',
              'created:desc',
            ],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  create_floating_ip: {
    body: {
      title: 'FloatingIPCreateRequest',
      type: 'object',
      properties: {
        type: {
          description: 'The Floating IP type.',
          type: 'string',
          enum: ['ipv4', 'ipv6'],
        },
        server: {
          description: 'Server the Floating IP is assigned to. null if not assigned.',
          type: ['integer', 'null'],
          format: 'int64',
        },
        home_location: {
          description: 'Home Location for the Floating IP. Either the ID or the name of the Location. Only optional if no Server is provided. Routing is optimized for this Locations.',
          oneOf: [
            {
              description: 'Home Location for the Floating IP. Either the ID or the name of the Location. Only optional if no Server is provided. Routing is optimized for this Locations.',
              type: 'string',
            },
            {
              description: 'Home Location for the Floating IP. Either the ID or the name of the Location. Only optional if no Server is provided. Routing is optimized for this Locations.',
              type: 'integer',
              format: 'int64',
              minimum: 1,
              maximum: 9007199254740991,
            },
          ],
        },
        description: {
          description: 'Description of the Resource.',
          type: ['string', 'null'],
        },
        name: {
          description: 'Name of the Resource. Must be unique per Project.',
          type: 'string',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
      additionalProperties: false,
      required: ['type'],
    },
  },
  get_floating_ip: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Floating IP.',
        schema: {
          description: 'ID of the Floating IP.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  update_floating_ip: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Floating IP.',
        schema: {
          description: 'ID of the Floating IP.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'FloatingIPUpdateRequest',
      type: 'object',
      properties: {
        description: {
          description: 'Description of the Resource.',
          type: ['string', 'null'],
        },
        name: {
          description: 'Name of the Resource. Must be unique per Project.',
          type: 'string',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. Note that the set of Labels provided in the request will overwrite the existing one. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
      additionalProperties: false,
    },
  },
  delete_floating_ip: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Floating IP.',
        schema: {
          description: 'ID of the Floating IP.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_floating_ip_actions: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Floating IP.',
        schema: {
          description: 'ID of the Floating IP.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_floating_ip_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Floating IP.',
        schema: {
          description: 'ID of the Floating IP.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'action_id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  assign_floating_ip: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Floating IP.',
        schema: {
          description: 'ID of the Floating IP.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'FloatingIPActionsAssignRequest',
      type: 'object',
      properties: {
        server: {
          description: 'Server the Floating IP is assigned to. null if not assigned.',
          type: ['integer', 'null'],
          format: 'int64',
        },
      },
      additionalProperties: false,
      required: ['server'],
    },
  },
  change_floating_ip_dns_ptr: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Floating IP.',
        schema: {
          description: 'ID of the Floating IP.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        ip: {
          description: 'Single IPv4 or IPv6 address to create pointer for.',
          type: 'string',
        },
        dns_ptr: {
          description: 'Domain Name to point to. PTR record content used for reverse DNS. Set to null to reset (IPv4) to the default value or remove (IPv6) the record.',
          type: ['string', 'null'],
        },
      },
      required: ['ip'],
    },
  },
  change_floating_ip_protection: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Floating IP.',
        schema: {
          description: 'ID of the Floating IP.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      description: 'Protection configuration for the Resource.',
      type: 'object',
      properties: {
        delete: {
          description: 'Prevent the Resource from being deleted.',
          type: 'boolean',
        },
      },
      required: ['delete'],
    },
  },
  unassign_floating_ip: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Floating IP.',
        schema: {
          description: 'ID of the Floating IP.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_floating_ips_actions: {
    params: [
      {
        name: 'id',
        in: 'query',
        description: 'Filter the actions by ID. May be used multiple times. The response will only contain actions matching the specified IDs.',
        schema: {
          type: 'array',
          items: {
            description: 'ID of the Action.',
            type: 'integer',
            format: 'int64',
            minimum: 1,
            maximum: 9007199254740991,
          },
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_floating_ips_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_images: {
    params: [
      {
        name: 'sort',
        in: 'query',
        description: 'Sort resources by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'name',
              'name:asc',
              'name:desc',
              'created',
              'created:asc',
              'created:desc',
            ],
          },
        },
      },
      {
        name: 'type',
        in: 'query',
        description: 'Filter resources by type. May be used multiple times. The response will only contain the resources with the specified type.',
        schema: {
          type: 'array',
          items: {
            description: 'Type of the Image.',
            type: 'string',
            enum: ['system', 'app', 'snapshot', 'backup'],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter resources by status. May be used multiple times. The response will only contain the resources with the specified status.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Image.',
            type: 'string',
            enum: ['available', 'creating', 'unavailable'],
          },
        },
      },
      {
        name: 'bound_to',
        in: 'query',
        description: 'Filter Images by their linked Server ID. May be used multiple times. Only available for Images of type backup.',
        schema: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      {
        name: 'include_deprecated',
        in: 'query',
        description: 'Include deprecated Images.',
        schema: {
          type: 'boolean',
        },
      },
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'label_selector',
        in: 'query',
        description: 'Filter resources by labels. The response will only contain resources matching the label selector. For more information, see "Label Selector".',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'architecture',
        in: 'query',
        description: 'Filter resources by cpu architecture. The response will only contain the resources with the specified cpu architecture.',
        schema: {
          description: 'CPU architecture of the Resource.',
          type: 'string',
          enum: ['x86', 'arm'],
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_image: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Image.',
        schema: {
          description: 'ID of the Image.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  update_image: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Image.',
        schema: {
          description: 'ID of the Image.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'UpdateImageRequest',
      type: 'object',
      properties: {
        description: {
          description: 'New description of Image.',
          type: 'string',
        },
        type: {
          description: 'Destination Image type to convert to.',
          type: 'string',
          enum: ['snapshot'],
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. Note that the set of Labels provided in the request will overwrite the existing one. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
    },
  },
  delete_image: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Image.',
        schema: {
          description: 'ID of the Image.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_image_actions: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Image.',
        schema: {
          description: 'ID of the Image.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_image_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Image.',
        schema: {
          description: 'ID of the Image.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'action_id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  change_image_protection: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Image.',
        schema: {
          description: 'ID of the Image.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        delete: {
          description: 'If true, prevents the snapshot from being deleted.',
          type: 'boolean',
        },
      },
    },
  },
  list_images_actions: {
    params: [
      {
        name: 'id',
        in: 'query',
        description: 'Filter the actions by ID. May be used multiple times. The response will only contain actions matching the specified IDs.',
        schema: {
          type: 'array',
          items: {
            description: 'ID of the Action.',
            type: 'integer',
            format: 'int64',
            minimum: 1,
            maximum: 9007199254740991,
          },
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_images_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_isos: {
    params: [
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'architecture',
        in: 'query',
        description: 'Filter resources by cpu architecture. The response will only contain the resources with the specified cpu architecture.',
        schema: {
          description: 'CPU architecture of the Resource.',
          type: 'string',
          enum: ['x86', 'arm'],
        },
      },
      {
        name: 'include_architecture_wildcard',
        in: 'query',
        description: 'Include Images with wildcard architecture (architecture is null). Architecture filter must be specified.',
        schema: {
          type: 'boolean',
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_iso: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the ISO.',
        schema: {
          description: 'ID of the ISO.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_load_balancer_types: {
    params: [
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_load_balancer_type: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer Type.',
        schema: {
          description: 'ID of the Load Balancer Type.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_load_balancers: {
    params: [
      {
        name: 'sort',
        in: 'query',
        description: 'Sort resources by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'name',
              'name:asc',
              'name:desc',
              'created',
              'created:asc',
              'created:desc',
            ],
          },
        },
      },
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'label_selector',
        in: 'query',
        description: 'Filter resources by labels. The response will only contain resources matching the label selector. For more information, see "Label Selector".',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  create_load_balancer: {
    body: {
      title: 'CreateLoadBalancerRequest',
      type: 'object',
      properties: {
        name: {
          description: 'Name of the Load Balancer.',
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: '^\\S(.*\\S)?$',
        },
        load_balancer_type: {
          description: 'ID or name of the Load Balancer type this Load Balancer should be created with.',
          type: 'string',
        },
        algorithm: {
          title: 'LoadBalancerAlgorithm',
          description: 'Algorithm of the Load Balancer.',
          type: 'object',
          properties: {
            type: {
              description: 'Type of the algorithm.',
              type: 'string',
              enum: ['round_robin', 'least_connections'],
            },
          },
          required: ['type'],
          default: {
            type: 'round_robin',
          },
        },
        services: {
          description: 'Array of services.',
          type: 'array',
          items: {
            title: 'LoadBalancerService',
            oneOf: [
              {
                title: 'LoadBalancerServiceTCP',
                allOf: [
                  {
                    type: 'object',
                    properties: {
                      protocol: {
                        description: 'Protocol of the Load Balancer.',
                        type: 'string',
                        enum: ['tcp', 'http', 'https'],
                      },
                      listen_port: {
                        description: 'Port the Load Balancer listens on.',
                        type: 'integer',
                      },
                      destination_port: {
                        description: 'Port the Load Balancer will balance to.',
                        type: 'integer',
                      },
                      proxyprotocol: {
                        description: 'Is Proxyprotocol enabled or not.',
                        type: 'boolean',
                      },
                      health_check: {
                        title: 'LoadBalancerServiceHealthCheck',
                        description: 'Service health check.',
                        type: 'object',
                        properties: {
                          protocol: {
                            description: 'Type of the health check.',
                            type: 'string',
                            enum: ['tcp', 'http'],
                          },
                          port: {
                            description: 'Port the health check will be performed on.',
                            type: 'integer',
                          },
                          interval: {
                            description: 'Time interval in seconds health checks are performed.',
                            type: 'integer',
                            minimum: 3,
                            maximum: 60,
                          },
                          timeout: {
                            description: 'Time in seconds after an attempt is considered a timeout.',
                            type: 'integer',
                            minimum: 1,
                            maximum: 60,
                          },
                          retries: {
                            description: 'Unsuccessful retries needed until a target is considered unhealthy; an unhealthy target needs the same number of successful retries to become healthy again.',
                            type: 'integer',
                            minimum: 1,
                            maximum: 5,
                          },
                          http: {
                            description: 'Additional configuration for protocol http.',
                            type: 'object',
                            properties: {
                              domain: {
                                description: 'Host header to send in the HTTP request. May not contain spaces, percent or backslash symbols. Can be null, in that case no host header is sent.',
                                type: ['string', 'null'],
                                maxLength: 128,
                              },
                              path: {
                                description: 'HTTP path to use for health checks. May not contain literal spaces, use percent-encoding instead.',
                                type: 'string',
                                minLength: 1,
                                maxLength: 256,
                              },
                              response: {
                                description: 'String that must be contained in HTTP response in order to pass the health check.',
                                type: 'string',
                                maxLength: 256,
                              },
                              status_codes: {
                                description: 'List of returned HTTP status codes in order to pass the health check. Supports the wildcards ? for exactly one character and for multiple ones.',
                                type: 'array',
                                items: {
                                  type: 'string',
                                },
                                default: ['2??', '3??'],
                                maxItems: 20,
                              },
                              tls: {
                                description: 'Use HTTPS for health check.',
                                type: 'boolean',
                              },
                            },
                            additionalProperties: false,
                            required: ['domain', 'path'],
                          },
                        },
                        additionalProperties: false,
                        required: [
                          'protocol',
                          'port',
                          'interval',
                          'timeout',
                          'retries',
                        ],
                      },
                    },
                    required: [
                      'protocol',
                      'listen_port',
                      'destination_port',
                      'proxyprotocol',
                      'health_check',
                    ],
                  },
                  {
                    type: 'object',
                    properties: {
                      protocol: {
                        type: 'string',
                        enum: ['tcp'],
                      },
                    },
                  },
                ],
              },
              {
                title: 'LoadBalancerServiceHTTPProtocol',
                allOf: [
                  {
                    type: 'object',
                    properties: {
                      protocol: {
                        description: 'Protocol of the Load Balancer.',
                        type: 'string',
                        enum: ['tcp', 'http', 'https'],
                      },
                      listen_port: {
                        description: 'Port the Load Balancer listens on.',
                        type: 'integer',
                      },
                      destination_port: {
                        description: 'Port the Load Balancer will balance to.',
                        type: 'integer',
                      },
                      proxyprotocol: {
                        description: 'Is Proxyprotocol enabled or not.',
                        type: 'boolean',
                      },
                      health_check: {
                        title: 'LoadBalancerServiceHealthCheck',
                        description: 'Service health check.',
                        type: 'object',
                        properties: {
                          protocol: {
                            description: 'Type of the health check.',
                            type: 'string',
                            enum: ['tcp', 'http'],
                          },
                          port: {
                            description: 'Port the health check will be performed on.',
                            type: 'integer',
                          },
                          interval: {
                            description: 'Time interval in seconds health checks are performed.',
                            type: 'integer',
                            minimum: 3,
                            maximum: 60,
                          },
                          timeout: {
                            description: 'Time in seconds after an attempt is considered a timeout.',
                            type: 'integer',
                            minimum: 1,
                            maximum: 60,
                          },
                          retries: {
                            description: 'Unsuccessful retries needed until a target is considered unhealthy; an unhealthy target needs the same number of successful retries to become healthy again.',
                            type: 'integer',
                            minimum: 1,
                            maximum: 5,
                          },
                          http: {
                            description: 'Additional configuration for protocol http.',
                            type: 'object',
                            properties: {
                              domain: {
                                description: 'Host header to send in the HTTP request. May not contain spaces, percent or backslash symbols. Can be null, in that case no host header is sent.',
                                type: ['string', 'null'],
                                maxLength: 128,
                              },
                              path: {
                                description: 'HTTP path to use for health checks. May not contain literal spaces, use percent-encoding instead.',
                                type: 'string',
                                minLength: 1,
                                maxLength: 256,
                              },
                              response: {
                                description: 'String that must be contained in HTTP response in order to pass the health check.',
                                type: 'string',
                                maxLength: 256,
                              },
                              status_codes: {
                                description: 'List of returned HTTP status codes in order to pass the health check. Supports the wildcards ? for exactly one character and for multiple ones.',
                                type: 'array',
                                items: {
                                  type: 'string',
                                },
                                default: ['2??', '3??'],
                                maxItems: 20,
                              },
                              tls: {
                                description: 'Use HTTPS for health check.',
                                type: 'boolean',
                              },
                            },
                            additionalProperties: false,
                            required: ['domain', 'path'],
                          },
                        },
                        additionalProperties: false,
                        required: [
                          'protocol',
                          'port',
                          'interval',
                          'timeout',
                          'retries',
                        ],
                      },
                    },
                    required: [
                      'protocol',
                      'listen_port',
                      'destination_port',
                      'proxyprotocol',
                      'health_check',
                    ],
                  },
                  {
                    type: 'object',
                    properties: {
                      protocol: {
                        type: 'string',
                        enum: ['http'],
                      },
                      http: {
                        title: 'LoadBalancerServiceHTTPConfig',
                        description: 'Configuration option for protocol http.',
                        type: 'object',
                        properties: {
                          cookie_name: {
                            description: 'Name of the cookie used for sticky sessions.',
                            type: 'string',
                            default: 'HCLBSTICKY',
                            minLength: 1,
                            maxLength: 100,
                          },
                          cookie_lifetime: {
                            description: 'Lifetime of the cookie used for sticky sessions (in seconds).',
                            type: 'integer',
                            default: 300,
                            minimum: 30,
                            maximum: 86400,
                          },
                          timeout_idle: {
                            description: 'Idle timeout in seconds for the client and server side.',
                            type: 'integer',
                            default: 50,
                            minimum: 30,
                            maximum: 300,
                          },
                          sticky_sessions: {
                            description: 'Use sticky sessions.',
                            type: 'boolean',
                            default: false,
                          },
                        },
                        required: [
                          'cookie_name',
                          'cookie_lifetime',
                          'timeout_idle',
                          'sticky_sessions',
                        ],
                      },
                    },
                    required: ['http'],
                  },
                ],
              },
              {
                title: 'LoadBalancerServiceHTTPSProtocol',
                allOf: [
                  {
                    type: 'object',
                    properties: {
                      protocol: {
                        description: 'Protocol of the Load Balancer.',
                        type: 'string',
                        enum: ['tcp', 'http', 'https'],
                      },
                      listen_port: {
                        description: 'Port the Load Balancer listens on.',
                        type: 'integer',
                      },
                      destination_port: {
                        description: 'Port the Load Balancer will balance to.',
                        type: 'integer',
                      },
                      proxyprotocol: {
                        description: 'Is Proxyprotocol enabled or not.',
                        type: 'boolean',
                      },
                      health_check: {
                        title: 'LoadBalancerServiceHealthCheck',
                        description: 'Service health check.',
                        type: 'object',
                        properties: {
                          protocol: {
                            description: 'Type of the health check.',
                            type: 'string',
                            enum: ['tcp', 'http'],
                          },
                          port: {
                            description: 'Port the health check will be performed on.',
                            type: 'integer',
                          },
                          interval: {
                            description: 'Time interval in seconds health checks are performed.',
                            type: 'integer',
                            minimum: 3,
                            maximum: 60,
                          },
                          timeout: {
                            description: 'Time in seconds after an attempt is considered a timeout.',
                            type: 'integer',
                            minimum: 1,
                            maximum: 60,
                          },
                          retries: {
                            description: 'Unsuccessful retries needed until a target is considered unhealthy; an unhealthy target needs the same number of successful retries to become healthy again.',
                            type: 'integer',
                            minimum: 1,
                            maximum: 5,
                          },
                          http: {
                            description: 'Additional configuration for protocol http.',
                            type: 'object',
                            properties: {
                              domain: {
                                description: 'Host header to send in the HTTP request. May not contain spaces, percent or backslash symbols. Can be null, in that case no host header is sent.',
                                type: ['string', 'null'],
                                maxLength: 128,
                              },
                              path: {
                                description: 'HTTP path to use for health checks. May not contain literal spaces, use percent-encoding instead.',
                                type: 'string',
                                minLength: 1,
                                maxLength: 256,
                              },
                              response: {
                                description: 'String that must be contained in HTTP response in order to pass the health check.',
                                type: 'string',
                                maxLength: 256,
                              },
                              status_codes: {
                                description: 'List of returned HTTP status codes in order to pass the health check. Supports the wildcards ? for exactly one character and for multiple ones.',
                                type: 'array',
                                items: {
                                  type: 'string',
                                },
                                default: ['2??', '3??'],
                                maxItems: 20,
                              },
                              tls: {
                                description: 'Use HTTPS for health check.',
                                type: 'boolean',
                              },
                            },
                            additionalProperties: false,
                            required: ['domain', 'path'],
                          },
                        },
                        additionalProperties: false,
                        required: [
                          'protocol',
                          'port',
                          'interval',
                          'timeout',
                          'retries',
                        ],
                      },
                    },
                    required: [
                      'protocol',
                      'listen_port',
                      'destination_port',
                      'proxyprotocol',
                      'health_check',
                    ],
                  },
                  {
                    type: 'object',
                    properties: {
                      protocol: {
                        type: 'string',
                        enum: ['https'],
                      },
                      http: {
                        title: 'LoadBalancerServiceHTTPSConfig',
                        description: 'Configuration option for protocol https.',
                        type: 'object',
                        properties: {
                          cookie_name: {
                            description: 'Name of the cookie used for sticky sessions.',
                            type: 'string',
                            default: 'HCLBSTICKY',
                            minLength: 1,
                            maxLength: 100,
                          },
                          cookie_lifetime: {
                            description: 'Lifetime of the cookie used for sticky sessions (in seconds).',
                            type: 'integer',
                            default: 300,
                            minimum: 30,
                            maximum: 86400,
                          },
                          timeout_idle: {
                            description: 'Idle timeout in seconds for the client and server side.',
                            type: 'integer',
                            default: 50,
                            minimum: 30,
                            maximum: 300,
                          },
                          certificates: {
                            description: 'IDs of the Certificates to use for TLS/SSL termination by the Load Balancer; empty for TLS/SSL passthrough.',
                            type: 'array',
                            items: {
                              type: 'integer',
                              format: 'int64',
                            },
                          },
                          redirect_http: {
                            description: 'Redirect HTTP requests to HTTPS.',
                            type: 'boolean',
                            default: false,
                          },
                          sticky_sessions: {
                            description: 'Use sticky sessions.',
                            type: 'boolean',
                            default: false,
                          },
                        },
                        required: [
                          'cookie_name',
                          'cookie_lifetime',
                          'timeout_idle',
                          'certificates',
                          'redirect_http',
                          'sticky_sessions',
                        ],
                      },
                    },
                    required: ['http'],
                  },
                ],
              },
            ],
          },
        },
        targets: {
          description: 'Array of targets.',
          type: 'array',
          items: {
            allOf: [
              {
                title: 'LoadBalancerTarget',
                description: 'Configuration of a Load Balancer target.',
                type: 'object',
                properties: {
                  type: {
                    description: 'Type of the resource.',
                    type: 'string',
                    enum: ['server', 'label_selector', 'ip'],
                  },
                  server: {
                    title: 'LoadBalancerTargetServer',
                    description: 'Configuration for type Server, only valid and required if type is server.',
                    type: 'object',
                    properties: {
                      id: {
                        description: 'ID of the Server.',
                        type: 'integer',
                        format: 'int64',
                      },
                      ip: {
                        type: 'string',
                      },
                    },
                    additionalProperties: false,
                    required: ['id'],
                  },
                  label_selector: {
                    title: 'LoadBalancerTargetLabelSelector',
                    description: 'Configuration for label selector targets, only valid and required if type is labelselector.',
                    type: 'object',
                    properties: {
                      selector: {
                        description: 'Label selector.',
                        type: 'string',
                        minLength: 1,
                        maxLength: 1000,
                      },
                    },
                    required: ['selector'],
                  },
                  ip: {
                    title: 'LoadBalancerTargetIP',
                    type: 'object',
                    properties: {
                      ip: {
                        description: 'IP of a server that belongs to the same customer (public IPv4/IPv6) or private IP in a subnet type vswitch.',
                        type: 'string',
                      },
                    },
                    required: ['ip'],
                  },
                },
                required: ['type'],
              },
              {
                type: 'object',
                properties: {
                  use_private_ip: {
                    description: 'Use the private network IP instead of the public IP of the Server, requires the Server and Load Balancer to be in the same network. Only valid for target types server and labelselector.',
                    type: 'boolean',
                    default: false,
                  },
                },
              },
            ],
          },
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
        public_interface: {
          description: 'Enable or disable the public interface of the Load Balancer.',
          type: 'boolean',
        },
        network: {
          description: 'ID of the network the Load Balancer should be attached to on creation.',
          type: 'integer',
          format: 'int64',
        },
        network_zone: {
          description: 'Name of network zone.',
          type: 'string',
        },
        location: {
          description: 'ID or name of Location to create Load Balancer in.',
          type: 'string',
        },
      },
      required: ['name', 'load_balancer_type'],
    },
  },
  get_load_balancer: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  update_load_balancer: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        name: {
          description: 'New Load Balancer name.',
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: '^\\S(.*\\S)?$',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. Note that the set of Labels provided in the request will overwrite the existing one. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
    },
  },
  delete_load_balancer: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_load_balancer_actions: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_load_balancer_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'action_id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  add_load_balancer_service: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      allOf: [
        {
          title: 'LoadBalancerService',
          type: 'object',
          properties: {
            protocol: {
              description: 'Protocol of the Load Balancer.',
              type: 'string',
              enum: ['tcp', 'http', 'https'],
            },
            listen_port: {
              description: 'Port the Load Balancer listens on.',
              type: 'integer',
            },
            destination_port: {
              description: 'Port the Load Balancer will balance to.',
              type: 'integer',
            },
            proxyprotocol: {
              description: 'Is Proxyprotocol enabled or not.',
              type: 'boolean',
            },
            health_check: {
              allOf: [
                {
                  title: 'LoadBalancerServiceHealthCheck',
                  description: 'Service health check.',
                  type: 'object',
                  properties: {
                    protocol: {
                      description: 'Type of the health check.',
                      type: 'string',
                      enum: ['tcp', 'http'],
                    },
                    port: {
                      description: 'Port the health check will be performed on.',
                      type: 'integer',
                    },
                    interval: {
                      description: 'Time interval in seconds health checks are performed.',
                      type: 'integer',
                      minimum: 3,
                      maximum: 60,
                    },
                    timeout: {
                      description: 'Time in seconds after an attempt is considered a timeout.',
                      type: 'integer',
                      minimum: 1,
                      maximum: 60,
                    },
                    retries: {
                      description: 'Unsuccessful retries needed until a target is considered unhealthy; an unhealthy target needs the same number of successful retries to become healthy again.',
                      type: 'integer',
                      minimum: 1,
                      maximum: 5,
                    },
                    http: {
                      description: 'Additional configuration for protocol http.',
                      type: 'object',
                      properties: {
                        domain: {
                          description: 'Host header to send in the HTTP request. May not contain spaces, percent or backslash symbols. Can be null, in that case no host header is sent.',
                          type: ['string', 'null'],
                          maxLength: 128,
                        },
                        path: {
                          description: 'HTTP path to use for health checks. May not contain literal spaces, use percent-encoding instead.',
                          type: 'string',
                          minLength: 1,
                          maxLength: 256,
                        },
                        response: {
                          description: 'String that must be contained in HTTP response in order to pass the health check.',
                          type: 'string',
                          maxLength: 256,
                        },
                        status_codes: {
                          description: 'List of returned HTTP status codes in order to pass the health check. Supports the wildcards ? for exactly one character and for multiple ones.',
                          type: 'array',
                          items: {
                            type: 'string',
                          },
                          default: ['2??', '3??'],
                          maxItems: 20,
                        },
                        tls: {
                          description: 'Use HTTPS for health check.',
                          type: 'boolean',
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  additionalProperties: false,
                },
                {
                  type: 'object',
                  required: ['protocol', 'port', 'interval', 'timeout', 'retries'],
                },
              ],
            },
          },
        },
        {
          type: 'object',
          properties: {
            http: {
              title: 'LoadBalancerServiceHTTP',
              description: 'Configuration option for protocols http and https.',
              type: 'object',
              properties: {
                cookie_name: {
                  description: 'Name of the cookie used for sticky sessions.',
                  type: 'string',
                  default: 'HCLBSTICKY',
                  minLength: 1,
                  maxLength: 100,
                },
                cookie_lifetime: {
                  description: 'Lifetime of the cookie used for sticky sessions (in seconds).',
                  type: 'integer',
                  default: 300,
                  minimum: 30,
                  maximum: 86400,
                },
                timeout_idle: {
                  description: 'Idle timeout in seconds for the client and server side.',
                  type: 'integer',
                },
                certificates: {
                  description: 'IDs of the Certificates to use for TLS/SSL termination by the Load Balancer; empty for TLS/SSL passthrough or if protocol is http.',
                  type: 'array',
                  items: {
                    type: 'integer',
                    format: 'int64',
                  },
                },
                redirect_http: {
                  description: 'Redirect HTTP requests to HTTPS. Only available if protocol is https.',
                  type: 'boolean',
                  default: false,
                },
                sticky_sessions: {
                  description: 'Use sticky sessions. Only available if protocol is http or https.',
                  type: 'boolean',
                  default: false,
                },
              },
            },
          },
          required: [
            'protocol',
            'listen_port',
            'destination_port',
            'proxyprotocol',
            'health_check',
          ],
        },
      ],
    },
  },
  add_load_balancer_target: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      allOf: [
        {
          title: 'LoadBalancerTarget',
          description: 'Configuration of a Load Balancer target.',
          type: 'object',
          properties: {
            type: {
              description: 'Type of the resource.',
              type: 'string',
              enum: ['server', 'label_selector', 'ip'],
            },
            server: {
              title: 'LoadBalancerTargetServer',
              description: 'Configuration for type Server, only valid and required if type is server.',
              type: 'object',
              properties: {
                id: {
                  description: 'ID of the Server.',
                  type: 'integer',
                  format: 'int64',
                },
                ip: {
                  type: 'string',
                },
              },
              additionalProperties: false,
              required: ['id'],
            },
            label_selector: {
              title: 'LoadBalancerTargetLabelSelector',
              description: 'Configuration for label selector targets, only valid and required if type is labelselector.',
              type: 'object',
              properties: {
                selector: {
                  description: 'Label selector.',
                  type: 'string',
                  minLength: 1,
                  maxLength: 1000,
                },
              },
              required: ['selector'],
            },
            ip: {
              title: 'LoadBalancerTargetIP',
              type: 'object',
              properties: {
                ip: {
                  description: 'IP of a server that belongs to the same customer (public IPv4/IPv6) or private IP in a subnet type vswitch.',
                  type: 'string',
                },
              },
              required: ['ip'],
            },
          },
          required: ['type'],
        },
        {
          type: 'object',
          properties: {
            use_private_ip: {
              description: 'Use the private network IP instead of the public IP of the Server, requires the Server and Load Balancer to be in the same network. Only valid for target types server and labelselector.',
              type: 'boolean',
              default: false,
            },
          },
        },
      ],
    },
  },
  attach_load_balancer_to_network: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        network: {
          description: 'ID of an existing network to attach the Load Balancer to.',
          type: 'integer',
          format: 'int64',
        },
        ip: {
          description: 'IP to request to be assigned to this Load Balancer; if you do not provide this then you will be auto assigned an IP address.',
          type: 'string',
        },
        ip_range: {
          description: 'IP range in CIDR block notation of the subnet to attach to. This allows for auto assigning an IP address for a specific subnet. Providing ip that is not part of iprange will result in an error.',
          type: 'string',
        },
      },
      required: ['network'],
    },
  },
  change_load_balancer_algorithm: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'LoadBalancerAlgorithm',
      description: 'Algorithm of the Load Balancer.',
      type: 'object',
      properties: {
        type: {
          description: 'Type of the algorithm.',
          type: 'string',
          enum: ['round_robin', 'least_connections'],
        },
      },
      required: ['type'],
      default: {
        type: 'round_robin',
      },
    },
  },
  change_load_balancer_dns_ptr: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        ip: {
          description: 'Single IPv4 or IPv6 address to create pointer for.',
          type: 'string',
        },
        dns_ptr: {
          description: 'Domain Name to point to. PTR record content used for reverse DNS. Set to null to reset (IPv4) to the default value or remove (IPv6) the record.',
          type: ['string', 'null'],
        },
      },
      required: ['ip'],
    },
  },
  change_load_balancer_protection: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        delete: {
          description: 'If true, prevents the Load Balancer from being deleted.',
          type: 'boolean',
        },
      },
    },
  },
  change_load_balancer_type: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'ChangeTypeRequest',
      type: 'object',
      properties: {
        load_balancer_type: {
          description: 'ID or name of Load Balancer type the Load Balancer should migrate to.',
          type: 'string',
        },
      },
      required: ['load_balancer_type'],
    },
  },
  delete_load_balancer_service: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        listen_port: {
          description: 'The listen port of the service you want to delete.',
          type: 'integer',
        },
      },
      required: ['listen_port'],
    },
  },
  detach_load_balancer_from_network: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        network: {
          description: 'ID of an existing network to detach the Load Balancer from.',
          type: 'integer',
          format: 'int64',
        },
      },
      required: ['network'],
    },
  },
  disable_load_balancer_public_interface: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  enable_load_balancer_public_interface: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  remove_load_balancer_target: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'LoadBalancerTarget',
      description: 'Configuration of a Load Balancer target.',
      type: 'object',
      properties: {
        type: {
          description: 'Type of the resource.',
          type: 'string',
          enum: ['server', 'label_selector', 'ip'],
        },
        server: {
          title: 'LoadBalancerTargetServer',
          description: 'Configuration for type Server, only valid and required if type is server.',
          type: 'object',
          properties: {
            id: {
              description: 'ID of the Server.',
              type: 'integer',
              format: 'int64',
            },
            ip: {
              type: 'string',
            },
          },
          additionalProperties: false,
          required: ['id'],
        },
        label_selector: {
          title: 'LoadBalancerTargetLabelSelector',
          description: 'Configuration for label selector targets, only valid and required if type is labelselector.',
          type: 'object',
          properties: {
            selector: {
              description: 'Label selector.',
              type: 'string',
              minLength: 1,
              maxLength: 1000,
            },
          },
          required: ['selector'],
        },
        ip: {
          title: 'LoadBalancerTargetIP',
          type: 'object',
          properties: {
            ip: {
              description: 'IP of a server that belongs to the same customer (public IPv4/IPv6) or private IP in a subnet type vswitch.',
              type: 'string',
            },
          },
          required: ['ip'],
        },
      },
      required: ['type'],
    },
  },
  update_load_balancer_service: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'UpdateLoadBalancerService',
      allOf: [
        {
          title: 'LoadBalancerService',
          type: 'object',
          properties: {
            protocol: {
              description: 'Protocol of the Load Balancer.',
              type: 'string',
              enum: ['tcp', 'http', 'https'],
            },
            listen_port: {
              description: 'Port the Load Balancer listens on.',
              type: 'integer',
            },
            destination_port: {
              description: 'Port the Load Balancer will balance to.',
              type: 'integer',
            },
            proxyprotocol: {
              description: 'Is Proxyprotocol enabled or not.',
              type: 'boolean',
            },
            health_check: {
              allOf: [
                {
                  title: 'LoadBalancerServiceHealthCheck',
                  description: 'Service health check.',
                  type: 'object',
                  properties: {
                    protocol: {
                      description: 'Type of the health check.',
                      type: 'string',
                      enum: ['tcp', 'http'],
                    },
                    port: {
                      description: 'Port the health check will be performed on.',
                      type: 'integer',
                    },
                    interval: {
                      description: 'Time interval in seconds health checks are performed.',
                      type: 'integer',
                      minimum: 3,
                      maximum: 60,
                    },
                    timeout: {
                      description: 'Time in seconds after an attempt is considered a timeout.',
                      type: 'integer',
                      minimum: 1,
                      maximum: 60,
                    },
                    retries: {
                      description: 'Unsuccessful retries needed until a target is considered unhealthy; an unhealthy target needs the same number of successful retries to become healthy again.',
                      type: 'integer',
                      minimum: 1,
                      maximum: 5,
                    },
                    http: {
                      description: 'Additional configuration for protocol http.',
                      type: 'object',
                      properties: {
                        domain: {
                          description: 'Host header to send in the HTTP request. May not contain spaces, percent or backslash symbols. Can be null, in that case no host header is sent.',
                          type: ['string', 'null'],
                          maxLength: 128,
                        },
                        path: {
                          description: 'HTTP path to use for health checks. May not contain literal spaces, use percent-encoding instead.',
                          type: 'string',
                          minLength: 1,
                          maxLength: 256,
                        },
                        response: {
                          description: 'String that must be contained in HTTP response in order to pass the health check.',
                          type: 'string',
                          maxLength: 256,
                        },
                        status_codes: {
                          description: 'List of returned HTTP status codes in order to pass the health check. Supports the wildcards ? for exactly one character and for multiple ones.',
                          type: 'array',
                          items: {
                            type: 'string',
                          },
                          default: ['2??', '3??'],
                          maxItems: 20,
                        },
                        tls: {
                          description: 'Use HTTPS for health check.',
                          type: 'boolean',
                        },
                      },
                      additionalProperties: false,
                    },
                  },
                  additionalProperties: false,
                },
                {
                  type: 'object',
                  required: ['protocol', 'port', 'interval', 'timeout', 'retries'],
                },
              ],
            },
          },
        },
        {
          type: 'object',
          properties: {
            health_check: {
              title: 'LoadBalancerServiceHealthCheck',
              description: 'Service health check.',
              type: 'object',
              properties: {
                protocol: {
                  description: 'Type of the health check.',
                  type: 'string',
                  enum: ['tcp', 'http'],
                },
                port: {
                  description: 'Port the health check will be performed on.',
                  type: 'integer',
                },
                interval: {
                  description: 'Time interval in seconds health checks are performed.',
                  type: 'integer',
                  minimum: 3,
                  maximum: 60,
                },
                timeout: {
                  description: 'Time in seconds after an attempt is considered a timeout.',
                  type: 'integer',
                  minimum: 1,
                  maximum: 60,
                },
                retries: {
                  description: 'Unsuccessful retries needed until a target is considered unhealthy; an unhealthy target needs the same number of successful retries to become healthy again.',
                  type: 'integer',
                  minimum: 1,
                  maximum: 5,
                },
                http: {
                  description: 'Additional configuration for protocol http.',
                  type: 'object',
                  properties: {
                    domain: {
                      description: 'Host header to send in the HTTP request. May not contain spaces, percent or backslash symbols. Can be null, in that case no host header is sent.',
                      type: ['string', 'null'],
                      maxLength: 128,
                    },
                    path: {
                      description: 'HTTP path to use for health checks. May not contain literal spaces, use percent-encoding instead.',
                      type: 'string',
                      minLength: 1,
                      maxLength: 256,
                    },
                    response: {
                      description: 'String that must be contained in HTTP response in order to pass the health check.',
                      type: 'string',
                      maxLength: 256,
                    },
                    status_codes: {
                      description: 'List of returned HTTP status codes in order to pass the health check. Supports the wildcards ? for exactly one character and for multiple ones.',
                      type: 'array',
                      items: {
                        type: 'string',
                      },
                      default: ['2??', '3??'],
                      maxItems: 20,
                    },
                    tls: {
                      description: 'Use HTTPS for health check.',
                      type: 'boolean',
                    },
                  },
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
            http: {
              title: 'LoadBalancerServiceHTTP',
              description: 'Configuration option for protocols http and https.',
              type: 'object',
              properties: {
                cookie_name: {
                  description: 'Name of the cookie used for sticky sessions.',
                  type: 'string',
                  minLength: 1,
                  maxLength: 100,
                },
                cookie_lifetime: {
                  description: 'Lifetime of the cookie used for sticky sessions (in seconds).',
                  type: 'integer',
                  minimum: 30,
                  maximum: 86400,
                },
                timeout_idle: {
                  description: 'Idle timeout in seconds for the client and server side.',
                  type: 'integer',
                },
                certificates: {
                  description: 'IDs of the Certificates to use for TLS/SSL termination by the Load Balancer; empty for TLS/SSL passthrough or if protocol is http.',
                  type: 'array',
                  items: {
                    type: 'integer',
                    format: 'int64',
                  },
                },
                redirect_http: {
                  description: 'Redirect HTTP requests to HTTPS. Only available if protocol is https.',
                  type: 'boolean',
                  default: false,
                },
                sticky_sessions: {
                  description: 'Use sticky sessions. Only available if protocol is http or https.',
                  type: 'boolean',
                  default: false,
                },
              },
            },
          },
          required: ['listen_port'],
        },
      ],
    },
  },
  get_load_balancer_metrics: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Load Balancer.',
        schema: {
          description: 'ID of the Load Balancer.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'type',
        in: 'query',
        required: true,
        description: 'Type of metrics to get.',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'open_connections',
              'connections_per_second',
              'requests_per_second',
              'bandwidth',
            ],
          },
        },
      },
      {
        name: 'start',
        in: 'query',
        required: true,
        description: 'Start of period to get Metrics for (must be in RFC3339 format).',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'end',
        in: 'query',
        required: true,
        description: 'End of period to get Metrics for (must be in RFC3339 format).',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'step',
        in: 'query',
        description: 'Resolution of results in seconds.',
        schema: {
          type: 'string',
        },
      },
    ],
  },
  list_load_balancers_actions: {
    params: [
      {
        name: 'id',
        in: 'query',
        description: 'Filter the actions by ID. May be used multiple times. The response will only contain actions matching the specified IDs.',
        schema: {
          type: 'array',
          items: {
            description: 'ID of the Action.',
            type: 'integer',
            format: 'int64',
            minimum: 1,
            maximum: 9007199254740991,
          },
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_load_balancers_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_locations: {
    params: [
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort resources by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['id', 'id:asc', 'id:desc', 'name', 'name:asc', 'name:desc'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_location: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Location.',
        schema: {
          description: 'ID of the Location.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_networks: {
    params: [
      {
        name: 'sort',
        in: 'query',
        description: 'Sort resources by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'name',
              'name:asc',
              'name:desc',
              'created',
              'created:asc',
              'created:desc',
            ],
          },
        },
      },
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'label_selector',
        in: 'query',
        description: 'Filter resources by labels. The response will only contain resources matching the label selector. For more information, see "Label Selector".',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  create_network: {
    body: {
      title: 'NetworkCreateRequest',
      type: 'object',
      properties: {
        name: {
          description: 'Name of the Network.',
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        ip_range: {
          type: 'string',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
        subnets: {
          description: 'Array of subnets to allocate.',
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: {
                description: 'Type of subnet.',
                type: 'string',
                enum: ['cloud', 'server', 'vswitch'],
              },
              ip_range: {
                type: 'string',
              },
              network_zone: {
                description: 'Name of the Network Zone. The Location contains the networkzone property it belongs to.',
                type: 'string',
              },
              vswitch_id: {
                description: 'ID of the robot vSwitch. Must only be supplied for subnets of type vswitch.',
                type: 'integer',
                format: 'int64',
              },
            },
            additionalProperties: false,
            required: ['type', 'network_zone'],
          },
        },
        routes: {
          description: 'Array of routes set in this Network.',
          type: 'array',
          items: {
            type: 'object',
            properties: {
              destination: {
                type: 'string',
              },
              gateway: {
                type: 'string',
              },
            },
            additionalProperties: false,
            required: ['destination', 'gateway'],
          },
        },
        expose_routes_to_vswitch: {
          description: 'Toggle to expose routes to the Networks vSwitch. Indicates if the routes from this Network should be exposed to the vSwitch in this Network. Only takes effect if a vSwitch is setup in this Network.',
          type: 'boolean',
        },
      },
      additionalProperties: false,
      required: ['name', 'ip_range'],
    },
  },
  get_network: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Network.',
        schema: {
          description: 'ID of the Network.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  update_network: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Network.',
        schema: {
          description: 'ID of the Network.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'NetworkUpdateRequest',
      type: 'object',
      properties: {
        name: {
          description: 'New Network name.',
          type: 'string',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. Note that the set of Labels provided in the request will overwrite the existing one. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
        expose_routes_to_vswitch: {
          description: 'Toggle to expose routes to the Networks vSwitch. Indicates if the routes from this Network should be exposed to the vSwitch in this Network. Only takes effect if a vSwitch is setup in this Network.',
          type: 'boolean',
        },
      },
      additionalProperties: false,
    },
  },
  delete_network: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Network.',
        schema: {
          description: 'ID of the Network.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_network_actions: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Network.',
        schema: {
          description: 'ID of the Network.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_network_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Network.',
        schema: {
          description: 'ID of the Network.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'action_id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  add_network_route: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Network.',
        schema: {
          description: 'ID of the Network.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'AddRouteRequest',
      type: 'object',
      properties: {
        destination: {
          type: 'string',
        },
        gateway: {
          type: 'string',
        },
      },
      additionalProperties: false,
      required: ['destination', 'gateway'],
    },
  },
  add_network_subnet: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Network.',
        schema: {
          description: 'ID of the Network.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'AddSubnetRequest',
      type: 'object',
      properties: {
        type: {
          description: 'Type of subnet.',
          type: 'string',
          enum: ['cloud', 'server', 'vswitch'],
        },
        ip_range: {
          type: 'string',
        },
        network_zone: {
          description: 'Name of the Network Zone. The Location contains the networkzone it belongs to.',
          type: 'string',
        },
        vswitch_id: {
          description: 'ID of the robot vSwitch. Must be supplied if the subnet is of type vswitch.',
          type: 'integer',
          format: 'int64',
        },
      },
      additionalProperties: false,
      required: ['type', 'network_zone'],
    },
  },
  change_network_ip_range: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Network.',
        schema: {
          description: 'ID of the Network.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'ChangeIPRangeRequest',
      type: 'object',
      properties: {
        ip_range: {
          type: 'string',
        },
      },
      additionalProperties: false,
      required: ['ip_range'],
    },
  },
  change_network_protection: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Network.',
        schema: {
          description: 'ID of the Network.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'ChangeProtectionRequest',
      type: 'object',
      properties: {
        delete: {
          description: 'Delete protection setting. If true, prevents the Network from being deleted.',
          type: 'boolean',
        },
      },
      additionalProperties: false,
    },
  },
  delete_network_route: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Network.',
        schema: {
          description: 'ID of the Network.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'DeleteRouteRequest',
      type: 'object',
      properties: {
        destination: {
          type: 'string',
        },
        gateway: {
          type: 'string',
        },
      },
      additionalProperties: false,
      required: ['destination', 'gateway'],
    },
  },
  delete_network_subnet: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Network.',
        schema: {
          description: 'ID of the Network.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'DeleteSubnetRequest',
      type: 'object',
      properties: {
        ip_range: {
          description: 'IP range in CIDR block notation of the subnet to delete.',
          type: 'string',
        },
      },
      additionalProperties: false,
      required: ['ip_range'],
    },
  },
  list_networks_actions: {
    params: [
      {
        name: 'id',
        in: 'query',
        description: 'Filter the actions by ID. May be used multiple times. The response will only contain actions matching the specified IDs.',
        schema: {
          type: 'array',
          items: {
            description: 'ID of the Action.',
            type: 'integer',
            format: 'int64',
            minimum: 1,
            maximum: 9007199254740991,
          },
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_networks_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_placement_groups: {
    params: [
      {
        name: 'sort',
        in: 'query',
        description: 'Sort resources by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'name',
              'name:asc',
              'name:desc',
              'created',
              'created:asc',
              'created:desc',
            ],
          },
        },
      },
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'label_selector',
        in: 'query',
        description: 'Filter resources by labels. The response will only contain resources matching the label selector. For more information, see "Label Selector".',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'type',
        in: 'query',
        description: 'Filter resources by type. May be used multiple times. The response will only contain the resources with the specified type.',
        schema: {
          type: 'array',
          items: {
            description: 'Type of Placement Group.',
            type: 'string',
            enum: ['spread'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  create_placement_group: {
    body: {
      title: 'CreatePlacementGroupRequest',
      type: 'object',
      properties: {
        name: {
          description: 'Name of the Placement Group.',
          type: 'string',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
        type: {
          description: 'Define the Placement Group Type.',
          type: 'string',
          enum: ['spread'],
        },
      },
      required: ['name', 'type'],
    },
  },
  get_placement_group: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Placement Group.',
        schema: {
          description: 'ID of the Placement Group.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  update_placement_group: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Placement Group.',
        schema: {
          description: 'ID of the Placement Group.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'UpdatePlacementGroupRequest',
      type: 'object',
      properties: {
        name: {
          description: 'New Placement Group name.',
          type: 'string',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. Note that the set of Labels provided in the request will overwrite the existing one. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
    },
  },
  delete_placement_group: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Placement Group.',
        schema: {
          description: 'ID of the Placement Group.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_primary_ips: {
    params: [
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'label_selector',
        in: 'query',
        description: 'Filter resources by labels. The response will only contain resources matching the label selector. For more information, see "Label Selector".',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'ip',
        in: 'query',
        description: 'Filter results by IP address.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort resources by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'created',
              'created:asc',
              'created:desc',
            ],
          },
        },
      },
    ],
  },
  create_primary_ip: {
    body: {
      title: 'PrimaryIPCreateRequest',
      type: 'object',
      properties: {
        name: {
          description: 'Name of the Resource. Must be unique per Project.',
          type: 'string',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
        type: {
          description: 'Primary IP type.',
          type: 'string',
          enum: ['ipv4', 'ipv6'],
        },
        location: {
          description: 'Location ID or name the Primary IP will be bound to. Omit if assigneeid/assigneetype or datacenter are provided.',
          oneOf: [
            {
              description: 'Location ID or name the Primary IP will be bound to. Omit if assigneeid/assigneetype or datacenter are provided.',
              type: 'string',
            },
            {
              description: 'Location ID or name the Primary IP will be bound to. Omit if assigneeid/assigneetype or datacenter are provided.',
              type: 'integer',
              format: 'int64',
              minimum: 1,
              maximum: 9007199254740991,
            },
          ],
        },
        assignee_type: {
          description: 'Type of resource to assign the Primary IP to. Omitted if the Primary IP should not get assigned.',
          type: 'string',
          enum: ['server'],
        },
        assignee_id: {
          description: 'ID of resource to assign the Primary IP to. Omitted if the Primary IP should not get assigned.',
          type: ['integer', 'null'],
          format: 'int64',
        },
        auto_delete: {
          description: 'Auto deletion state. If enabled the Primary IP will be deleted once the assigned resource gets deleted.',
          type: 'boolean',
          default: false,
        },
      },
      additionalProperties: false,
      required: ['name', 'type'],
    },
  },
  get_primary_ip: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Primary IP.',
        schema: {
          description: 'ID of the Primary IP.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  update_primary_ip: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Primary IP.',
        schema: {
          description: 'ID of the Primary IP.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'PrimaryIPUpdateRequest',
      type: 'object',
      properties: {
        name: {
          description: 'Name of the Resource. Must be unique per Project.',
          type: 'string',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. Note that the set of Labels provided in the request will overwrite the existing one. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
        auto_delete: {
          description: 'Auto deletion state. If enabled the Primary IP will be deleted once the assigned resource gets deleted.',
          type: 'boolean',
          default: false,
        },
      },
      additionalProperties: false,
    },
  },
  delete_primary_ip: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Primary IP.',
        schema: {
          description: 'ID of the Primary IP.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_primary_ip_actions: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Primary IP.',
        schema: {
          description: 'ID of the Primary IP.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_primary_ip_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Primary IP.',
        schema: {
          description: 'ID of the Primary IP.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'action_id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  assign_primary_ip: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Primary IP.',
        schema: {
          description: 'ID of the Primary IP.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'PrimaryIPActionsAssignRequest',
      type: 'object',
      properties: {
        assignee_type: {
          description: 'Type of resource assigning the Primary IP to.',
          type: 'string',
          enum: ['server'],
        },
        assignee_id: {
          description: 'ID of a resource of type assigneetype.',
          type: 'integer',
          format: 'int64',
        },
      },
      additionalProperties: false,
      required: ['assignee_type', 'assignee_id'],
    },
  },
  change_primary_ip_dns_ptr: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Primary IP.',
        schema: {
          description: 'ID of the Primary IP.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        ip: {
          description: 'Single IPv4 or IPv6 address to create pointer for.',
          type: 'string',
        },
        dns_ptr: {
          description: 'Domain Name to point to. PTR record content used for reverse DNS. Set to null to reset (IPv4) to the default value or remove (IPv6) the record.',
          type: ['string', 'null'],
        },
      },
      required: ['ip'],
    },
  },
  change_primary_ip_protection: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Primary IP.',
        schema: {
          description: 'ID of the Primary IP.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      description: 'Protection configuration for the Resource.',
      type: 'object',
      properties: {
        delete: {
          description: 'Prevent the Resource from being deleted.',
          type: 'boolean',
        },
      },
      required: ['delete'],
    },
  },
  unassign_primary_ip: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Primary IP.',
        schema: {
          description: 'ID of the Primary IP.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_primary_ips_actions: {
    params: [
      {
        name: 'id',
        in: 'query',
        description: 'Filter the actions by ID. May be used multiple times. The response will only contain actions matching the specified IDs.',
        schema: {
          type: 'array',
          items: {
            description: 'ID of the Action.',
            type: 'integer',
            format: 'int64',
            minimum: 1,
            maximum: 9007199254740991,
          },
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_primary_ips_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_server_types: {
    params: [
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_server_type: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server Type.',
        schema: {
          description: 'ID of the Server Type.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_servers: {
    params: [
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'label_selector',
        in: 'query',
        description: 'Filter resources by labels. The response will only contain resources matching the label selector. For more information, see "Label Selector".',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort resources by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'name',
              'name:asc',
              'name:desc',
              'created',
              'created:asc',
              'created:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter resources by status. May be used multiple times. The response will only contain the resources with the specified status.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Server.',
            type: 'string',
            enum: [
              'running',
              'initializing',
              'starting',
              'stopping',
              'off',
              'deleting',
              'migrating',
              'rebuilding',
              'unknown',
            ],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  create_server: {
    body: {
      title: 'CreateServerRequest',
      type: 'object',
      properties: {
        name: {
          description: 'Name of the Server to create (must be unique per Project and a valid hostname as per RFC 1123).',
          type: 'string',
        },
        location: {
          description: 'ID or name of the Location to create the Server in.',
          type: 'string',
        },
        server_type: {
          description: 'ID or name of the Server type this Server should be created with.',
          type: 'string',
        },
        start_after_create: {
          description: 'This automatically triggers a Power on a Server-Server Action after the creation is finished and is returned in the nextactions response object.',
          type: 'boolean',
          default: true,
        },
        image: {
          description: 'ID or name of the Image the Server is created from.',
          type: 'string',
        },
        placement_group: {
          description: 'ID of the Placement Group the Server should be in.',
          type: 'integer',
          format: 'int64',
        },
        ssh_keys: {
          description: 'SSH key IDs (integer) or names (string) which should be injected into the Server at creation time.',
          type: 'array',
          items: {
            type: 'string',
          },
        },
        volumes: {
          description: 'Volume IDs which should be attached to the Server at the creation time. Volumes must be in the same Location.',
          type: 'array',
          items: {
            type: 'integer',
            format: 'int64',
          },
        },
        networks: {
          description: 'Network IDs which should be attached to the Server private network interface at the creation time.',
          type: 'array',
          items: {
            type: 'integer',
            format: 'int64',
          },
        },
        firewalls: {
          description: 'Firewalls which should be applied on the Server\'s public network interface at creation time.',
          type: 'array',
          items: {
            type: 'object',
            properties: {
              firewall: {
                description: 'ID of the Firewall.',
                type: 'integer',
                format: 'int64',
              },
            },
            required: ['firewall'],
          },
        },
        user_data: {
          description: 'Cloud-Init user data to use during Server creation. This field is limited to 32KiB.',
          type: 'string',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
        automount: {
          description: 'Auto-mount Volumes after attach.',
          type: 'boolean',
        },
        public_net: {
          description: 'Public Network options.',
          type: 'object',
          properties: {
            enable_ipv4: {
              description: 'Attach an IPv4 on the public NIC. If false, no IPv4 address will be attached.',
              type: 'boolean',
              default: true,
            },
            enable_ipv6: {
              description: 'Attach an IPv6 on the public NIC. If false, no IPv6 address will be attached.',
              type: 'boolean',
              default: true,
            },
            ipv4: {
              description: 'ID of the ipv4 Primary IP to use. If omitted and enableipv4 is true, a new ipv4 Primary IP will automatically be created.',
              type: ['integer', 'null'],
            },
            ipv6: {
              description: 'ID of the ipv6 Primary IP to use. If omitted and enableipv6 is true, a new ipv6 Primary IP will automatically be created.',
              type: ['integer', 'null'],
            },
          },
        },
      },
      required: ['name', 'server_type', 'image'],
    },
  },
  get_server: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  update_server: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'UpdateServerRequest',
      type: 'object',
      properties: {
        name: {
          description: 'New name to set.',
          type: 'string',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. Note that the set of Labels provided in the request will overwrite the existing one. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
    },
  },
  delete_server: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_server_actions: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_server_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'action_id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  add_server_to_placement_group: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'AddToPlacementGroupRequest',
      type: 'object',
      properties: {
        placement_group: {
          description: 'ID of Placement Group the Server should be added to.',
          type: 'integer',
          format: 'int64',
        },
      },
      required: ['placement_group'],
    },
  },
  attach_server_iso: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        iso: {
          description: 'ID or name of ISO to attach to the Server as listed in GET /isos.',
          type: 'string',
        },
      },
      required: ['iso'],
    },
  },
  attach_server_to_network: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'AttachToNetworkRequest',
      type: 'object',
      properties: {
        network: {
          description: 'ID of an existing network to attach the Server to.',
          type: 'integer',
          format: 'int64',
        },
        ip: {
          description: 'IP to request to be assigned to this Server; if you do not provide this then you will be auto assigned an IP address.',
          type: 'string',
        },
        alias_ips: {
          description: 'Additional IPs to be assigned to this Server.',
          type: 'array',
          items: {
            type: 'string',
          },
        },
        ip_range: {
          description: 'IP range in CIDR block notation of the subnet to attach to. This allows for auto assigning an IP address for a specific subnet. Providing ip that is not part of iprange will result in an error.',
          type: 'string',
        },
      },
      required: ['network'],
    },
  },
  change_server_alias_ips: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        network: {
          description: 'ID of an existing Network already attached to the Server.',
          type: 'integer',
          format: 'int64',
        },
        alias_ips: {
          description: 'New alias IPs to set for this Server.',
          type: 'array',
          items: {
            type: 'string',
          },
        },
      },
      required: ['network', 'alias_ips'],
    },
  },
  change_server_dns_ptr: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        ip: {
          description: 'Single IPv4 or IPv6 address to create pointer for.',
          type: 'string',
        },
        dns_ptr: {
          description: 'Domain Name to point to. PTR record content used for reverse DNS. Set to null to reset (IPv4) to the default value or remove (IPv6) the record.',
          type: ['string', 'null'],
        },
      },
      required: ['ip'],
    },
  },
  change_server_protection: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        delete: {
          description: 'If true, prevents the Server from being deleted (currently delete and rebuild attribute needs to have the same value).',
          type: 'boolean',
        },
        rebuild: {
          description: 'If true, prevents the Server from being rebuilt (currently delete and rebuild attribute needs to have the same value).',
          type: 'boolean',
        },
      },
    },
  },
  change_server_type: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        upgrade_disk: {
          description: 'If false, do not upgrade the disk (this allows downgrading the Server type later).',
          type: 'boolean',
        },
        server_type: {
          description: 'ID or name of Server type the Server should migrate to.',
          type: 'string',
        },
      },
      required: ['upgrade_disk', 'server_type'],
    },
  },
  create_server_image: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'CreateImageRequest',
      type: 'object',
      properties: {
        description: {
          description: 'Description of the Image, will be auto-generated if not set.',
          type: 'string',
        },
        type: {
          description: 'Type of Image to create.',
          type: 'string',
          enum: ['snapshot', 'backup'],
          default: 'snapshot',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
    },
  },
  detach_server_from_network: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'DetachFromNetworkRequest',
      type: 'object',
      properties: {
        network: {
          description: 'ID of an existing network to detach the Server from.',
          type: 'integer',
          format: 'int64',
        },
      },
      required: ['network'],
    },
  },
  detach_server_iso: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  disable_server_backup: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  disable_server_rescue: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  enable_server_backup: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  enable_server_rescue: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        type: {
          description: 'Type of rescue system to boot.',
          type: 'string',
          enum: ['linux64'],
          default: 'linux64',
        },
        ssh_keys: {
          description: 'Array of SSH key IDs which should be injected into the rescue system.',
          type: 'array',
          items: {
            type: 'integer',
            format: 'int64',
          },
        },
      },
    },
  },
  poweroff_server: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  poweron_server: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  reboot_server: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  rebuild_server: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'RebuildServerRequest',
      type: 'object',
      properties: {
        image: {
          description: 'ID or name of Image to rebuilt from.',
          type: 'string',
        },
        user_data: {
          description: 'Cloud-Init user data to use during Server rebuild. This field is limited to 32KiB. If not specified, the Server\'s previous userdata value will be re-used (if any was set).',
          type: 'string',
        },
      },
      required: ['image'],
    },
  },
  remove_server_from_placement_group: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  request_server_console: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  reset_server: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  reset_server_password: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  shutdown_server: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  get_server_metrics: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Server.',
        schema: {
          description: 'ID of the Server.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'type',
        in: 'query',
        required: true,
        description: 'Type of metrics to get.',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['cpu', 'disk', 'network'],
          },
        },
      },
      {
        name: 'start',
        in: 'query',
        required: true,
        description: 'Start of period to get Metrics for (must be in RFC3339 format).',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'end',
        in: 'query',
        required: true,
        description: 'End of period to get Metrics for (must be in RFC3339 format).',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'step',
        in: 'query',
        description: 'Resolution of results in seconds.',
        schema: {
          type: 'string',
        },
      },
    ],
  },
  list_servers_actions: {
    params: [
      {
        name: 'id',
        in: 'query',
        description: 'Filter the actions by ID. May be used multiple times. The response will only contain actions matching the specified IDs.',
        schema: {
          type: 'array',
          items: {
            description: 'ID of the Action.',
            type: 'integer',
            format: 'int64',
            minimum: 1,
            maximum: 9007199254740991,
          },
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_servers_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_ssh_keys: {
    params: [
      {
        name: 'sort',
        in: 'query',
        description: 'Sort resources by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['id', 'id:asc', 'id:desc', 'name', 'name:asc', 'name:desc'],
          },
        },
      },
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'fingerprint',
        in: 'query',
        description: 'May be used to filter SSH keys by their fingerprint. The response will only contain the SSH key matching the specified fingerprint.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'label_selector',
        in: 'query',
        description: 'Filter resources by labels. The response will only contain resources matching the label selector. For more information, see "Label Selector".',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  create_ssh_key: {
    body: {
      type: 'object',
      properties: {
        name: {
          description: 'Name of the SSH key.',
          type: 'string',
        },
        public_key: {
          description: 'Public key.',
          type: 'string',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
      required: ['name', 'public_key'],
    },
  },
  get_ssh_key: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the SSH Key.',
        schema: {
          description: 'ID of the SSH Key.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  update_ssh_key: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the SSH Key.',
        schema: {
          description: 'ID of the SSH Key.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        name: {
          description: 'New name Name to set.',
          type: 'string',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. Note that the set of Labels provided in the request will overwrite the existing one. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
    },
  },
  delete_ssh_key: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the SSH Key.',
        schema: {
          description: 'ID of the SSH Key.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_volumes: {
    params: [
      {
        name: 'status',
        in: 'query',
        description: 'Filter resources by status. May be used multiple times. The response will only contain the resources with the specified status.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Volume.',
            type: 'string',
            enum: ['available', 'creating'],
          },
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort resources by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'name',
              'name:asc',
              'name:desc',
              'created',
              'created:asc',
              'created:desc',
            ],
          },
        },
      },
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'label_selector',
        in: 'query',
        description: 'Filter resources by labels. The response will only contain resources matching the label selector. For more information, see "Label Selector".',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  create_volume: {
    body: {
      title: 'CreateVolumeRequest',
      type: 'object',
      properties: {
        size: {
          description: 'Size of the Volume in GB.',
          type: 'integer',
        },
        name: {
          description: 'Name of the volume.',
          type: 'string',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
        automount: {
          description: 'Auto-mount Volume after attach. server must be provided.',
          type: 'boolean',
        },
        format: {
          description: 'Format Volume after creation. One of: xfs, ext4.',
          type: 'string',
        },
        location: {
          description: 'Location to create the Volume in (can be omitted if Server is specified).',
          type: 'string',
        },
        server: {
          description: 'Server to which to attach the Volume once it\'s created (Volume will be created in the same Location as the server).',
          type: 'integer',
          format: 'int64',
        },
      },
      required: ['size', 'name'],
    },
  },
  get_volume: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Volume.',
        schema: {
          description: 'ID of the Volume.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  update_volume: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Volume.',
        schema: {
          description: 'ID of the Volume.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'UpdateVolumeRequest',
      type: 'object',
      properties: {
        name: {
          description: 'New Volume name.',
          type: 'string',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. Note that the set of Labels provided in the request will overwrite the existing one. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
    },
  },
  delete_volume: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Volume.',
        schema: {
          description: 'ID of the Volume.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_volume_actions: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Volume.',
        schema: {
          description: 'ID of the Volume.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_volume_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Volume.',
        schema: {
          description: 'ID of the Volume.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'action_id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  attach_volume: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Volume.',
        schema: {
          description: 'ID of the Volume.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      title: 'AttachVolumeRequest',
      type: 'object',
      properties: {
        server: {
          description: 'ID of the Server the Volume will be attached to.',
          type: 'integer',
          format: 'int64',
        },
        automount: {
          description: 'Auto-mount the Volume after attaching it.',
          type: 'boolean',
        },
      },
      required: ['server'],
    },
  },
  change_volume_protection: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Volume.',
        schema: {
          description: 'ID of the Volume.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        delete: {
          description: 'If true, prevents the Volume from being deleted.',
          type: 'boolean',
        },
      },
    },
  },
  detach_volume: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Volume.',
        schema: {
          description: 'ID of the Volume.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  resize_volume: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Volume.',
        schema: {
          description: 'ID of the Volume.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        size: {
          description: 'New Volume size in GB (must be greater than current size).',
          type: 'number',
        },
      },
      required: ['size'],
    },
  },
  list_volumes_actions: {
    params: [
      {
        name: 'id',
        in: 'query',
        description: 'Filter the actions by ID. May be used multiple times. The response will only contain actions matching the specified IDs.',
        schema: {
          type: 'array',
          items: {
            description: 'ID of the Action.',
            type: 'integer',
            format: 'int64',
            minimum: 1,
            maximum: 9007199254740991,
          },
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_volumes_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_zones: {
    params: [
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'mode',
        in: 'query',
        description: 'Filter resources by their mode. The response will only contain the resources matching exactly the specified mode.',
        schema: {
          description: 'Mode of the Zone. For more information, see Zone Modes.',
          type: 'string',
          enum: ['primary', 'secondary'],
        },
      },
      {
        name: 'label_selector',
        in: 'query',
        description: 'Filter resources by labels. The response will only contain resources matching the label selector. For more information, see "Label Selector".',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort resources by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'name',
              'name:asc',
              'name:desc',
              'created',
              'created:asc',
              'created:desc',
            ],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  create_zone: {
    body: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          maxLength: 255,
        },
        mode: {
          description: 'Mode of the Zone. For more information, see Zone Modes.',
          type: 'string',
          enum: ['primary', 'secondary'],
        },
        ttl: {
          description: 'Default Time To Live (TTL) of the Zone. Must be in between 60s and 2147483647s. This TTL is used for RRSets that do not explicitly define a TTL.',
          type: 'integer',
          default: 3600,
          minimum: 60,
          maximum: 2147483647,
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
        primary_nameservers: {
          description: 'Primary nameservers of the Zone. Only applicable for Zones in secondary mode. Ignored for Zones in primary mode.',
          type: 'array',
          items: {
            description: 'Primary nameserver that returns Zones via AXFR. Must allow queries from and may send NOTIFY queries to Hetzner\'s secondary nameservers.',
            type: 'object',
            properties: {
              address: {
                description: 'Public IPv4 or IPv6 address of the primary nameserver. Must be unique across all primary nameservers of this zone.',
                type: 'string',
              },
              port: {
                description: 'Port of the primary nameserver.',
                type: 'integer',
                default: 53,
              },
              tsig_key: {
                description: 'Transaction signature (TSIG) key to use for the zone transfer. Must be base64 encoded.',
                type: 'string',
              },
              tsig_algorithm: {
                description: 'Transaction signature (TSIG) algorithm used to generate the TSIG key.',
                type: 'string',
                enum: ['hmac-md5', 'hmac-sha1', 'hmac-sha256'],
              },
            },
            additionalProperties: false,
            required: ['address'],
          },
        },
        rrsets: {
          description: 'RRSets to be added to the Zone. Only applicable for Zones in primary mode. Ignored for Zones in secondary mode.',
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
              },
              type: {
                description: 'Type of the RRSet.',
                type: 'string',
                enum: [
                  'A',
                  'AAAA',
                  'CAA',
                  'CNAME',
                  'DS',
                  'HINFO',
                  'HTTPS',
                  'MX',
                  'NS',
                  'PTR',
                  'RP',
                  'SOA',
                  'SRV',
                  'SVCB',
                  'TLSA',
                  'TXT',
                ],
              },
              ttl: {
                description: 'Time To Live (TTL) of the RRSet. Must be in between 60s and 2147483647s. If not set, the Zone\'s Default TTL is used.',
                type: ['integer', 'null'],
                minimum: 60,
                maximum: 2147483647,
              },
              records: {
                description: 'Records of the RRSet. Must not be empty and must only contain distinct record values. The order of records returned in responses is not guaranteed to be consistent.',
                type: 'array',
                items: {
                  title: 'Record',
                  description: 'Record of a RRSet. The value is used to identify the record in an RRSet.',
                  type: 'object',
                  properties: {
                    value: {
                      description: 'Value of the record. For details about accepted values, see the DNS record types documentation.',
                      type: 'string',
                    },
                    comment: {
                      description: 'Comment of the record.',
                      type: 'string',
                    },
                  },
                  additionalProperties: false,
                  required: ['value'],
                },
              },
              labels: {
                description: 'User-defined labels (key/value pairs) for the Resource. For more information, see "Labels".',
                type: 'object',
                additionalProperties: {
                  type: 'string',
                },
              },
            },
            additionalProperties: false,
            required: ['name', 'type', 'records'],
          },
        },
        zonefile: {
          description: 'Zone file to import. Only applicable for Zones in primary mode. Ignored for Zones in secondary mode. If provided, rrsets must be empty. See Zone file import for more details.',
          type: 'string',
        },
      },
      additionalProperties: false,
      required: ['name', 'mode'],
    },
  },
  get_zone: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
    ],
  },
  update_zone: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
    ],
    body: {
      title: 'ZoneUpdateRequest',
      type: 'object',
      properties: {
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. Note that the set of Labels provided in the request will overwrite the existing one. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
      additionalProperties: false,
    },
  },
  delete_zone: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
    ],
  },
  list_zone_actions: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_zone_action: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
      {
        name: 'action_id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  change_zone_primary_nameservers: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        primary_nameservers: {
          description: 'Primary nameservers of the Zone.',
          type: 'array',
          items: {
            description: 'Primary nameserver that returns Zones via AXFR. Must allow queries from and may send NOTIFY queries to Hetzner\'s secondary nameservers.',
            type: 'object',
            properties: {
              address: {
                description: 'Public IPv4 or IPv6 address of the primary nameserver. Must be unique across all primary nameservers of this zone.',
                type: 'string',
              },
              port: {
                description: 'Port of the primary nameserver.',
                type: 'integer',
                default: 53,
              },
              tsig_key: {
                description: 'Transaction signature (TSIG) key to use for the zone transfer. Must be base64 encoded.',
                type: 'string',
              },
              tsig_algorithm: {
                description: 'Transaction signature (TSIG) algorithm used to generate the TSIG key.',
                type: 'string',
                enum: ['hmac-md5', 'hmac-sha1', 'hmac-sha256'],
              },
            },
            additionalProperties: false,
            required: ['address'],
          },
        },
      },
      additionalProperties: false,
      required: ['primary_nameservers'],
    },
  },
  change_zone_protection: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        delete: {
          description: 'Prevents the Zone from being deleted.',
          type: 'boolean',
        },
      },
      additionalProperties: false,
    },
  },
  change_zone_ttl: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        ttl: {
          description: 'Default Time To Live (TTL) of the Zone. Must be in between 60s and 2147483647s. This TTL is used for RRSets that do not explicitly define a TTL.',
          type: 'integer',
          default: 3600,
          minimum: 60,
          maximum: 2147483647,
        },
      },
      additionalProperties: false,
      required: ['ttl'],
    },
  },
  import_zone_zonefile: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        zonefile: {
          description: 'Zone file to import. See Zone file import for more details.',
          type: 'string',
        },
      },
      additionalProperties: false,
      required: ['zonefile'],
    },
  },
  list_zone_rrsets: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'type',
        in: 'query',
        description: 'Filter resources by their type. May be used multiple times. The response will only contain resources matching the specified types.',
        schema: {
          type: 'array',
          items: {
            description: 'Type of the RRSet.',
            type: 'string',
            enum: [
              'A',
              'AAAA',
              'CAA',
              'CNAME',
              'DS',
              'HINFO',
              'HTTPS',
              'MX',
              'NS',
              'PTR',
              'RP',
              'SOA',
              'SRV',
              'SVCB',
              'TLSA',
              'TXT',
            ],
          },
        },
      },
      {
        name: 'label_selector',
        in: 'query',
        description: 'Filter resources by labels. The response will only contain resources matching the label selector. For more information, see "Label Selector".',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort resources by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'name',
              'name:asc',
              'name:desc',
              'created',
              'created:asc',
              'created:desc',
            ],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  create_zone_rrset: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
        },
        type: {
          description: 'Type of the RRSet.',
          type: 'string',
          enum: [
            'A',
            'AAAA',
            'CAA',
            'CNAME',
            'DS',
            'HINFO',
            'HTTPS',
            'MX',
            'NS',
            'PTR',
            'RP',
            'SOA',
            'SRV',
            'SVCB',
            'TLSA',
            'TXT',
          ],
        },
        ttl: {
          description: 'Time To Live (TTL) of the RRSet. Must be in between 60s and 2147483647s. If not set, the Zone\'s Default TTL is used.',
          type: ['integer', 'null'],
          minimum: 60,
          maximum: 2147483647,
        },
        records: {
          description: 'Records of the RRSet. Must not be empty and must only contain distinct record values. The order of records returned in responses is not guaranteed to be consistent.',
          type: 'array',
          items: {
            title: 'Record',
            description: 'Record of a RRSet. The value is used to identify the record in an RRSet.',
            type: 'object',
            properties: {
              value: {
                description: 'Value of the record. For details about accepted values, see the DNS record types documentation.',
                type: 'string',
              },
              comment: {
                description: 'Comment of the record.',
                type: 'string',
              },
            },
            additionalProperties: false,
            required: ['value'],
          },
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
      additionalProperties: false,
      required: ['name', 'type', 'records'],
    },
  },
  get_zone_rrset: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
      {
        name: 'rr_name',
        in: 'path',
        required: true,
        schema: {
          type: 'string',
        },
      },
      {
        name: 'rr_type',
        in: 'path',
        required: true,
        schema: {
          description: 'Type of the RRSet.',
          type: 'string',
          enum: [
            'A',
            'AAAA',
            'CAA',
            'CNAME',
            'DS',
            'HINFO',
            'HTTPS',
            'MX',
            'NS',
            'PTR',
            'RP',
            'SOA',
            'SRV',
            'SVCB',
            'TLSA',
            'TXT',
          ],
        },
      },
    ],
  },
  update_zone_rrset: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
      {
        name: 'rr_name',
        in: 'path',
        required: true,
        schema: {
          type: 'string',
        },
      },
      {
        name: 'rr_type',
        in: 'path',
        required: true,
        schema: {
          description: 'Type of the RRSet.',
          type: 'string',
          enum: [
            'A',
            'AAAA',
            'CAA',
            'CNAME',
            'DS',
            'HINFO',
            'HTTPS',
            'MX',
            'NS',
            'PTR',
            'RP',
            'SOA',
            'SRV',
            'SVCB',
            'TLSA',
            'TXT',
          ],
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. Note that the set of Labels provided in the request will overwrite the existing one. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
      additionalProperties: false,
    },
  },
  delete_zone_rrset: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
      {
        name: 'rr_name',
        in: 'path',
        required: true,
        schema: {
          type: 'string',
        },
      },
      {
        name: 'rr_type',
        in: 'path',
        required: true,
        schema: {
          description: 'Type of the RRSet.',
          type: 'string',
          enum: [
            'A',
            'AAAA',
            'CAA',
            'CNAME',
            'DS',
            'HINFO',
            'HTTPS',
            'MX',
            'NS',
            'PTR',
            'RP',
            'SOA',
            'SRV',
            'SVCB',
            'TLSA',
            'TXT',
          ],
        },
      },
    ],
  },
  add_zone_rrset_records: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
      {
        name: 'rr_name',
        in: 'path',
        required: true,
        schema: {
          type: 'string',
        },
      },
      {
        name: 'rr_type',
        in: 'path',
        required: true,
        schema: {
          description: 'Type of the RRSet.',
          type: 'string',
          enum: [
            'A',
            'AAAA',
            'CAA',
            'CNAME',
            'DS',
            'HINFO',
            'HTTPS',
            'MX',
            'NS',
            'PTR',
            'RP',
            'SOA',
            'SRV',
            'SVCB',
            'TLSA',
            'TXT',
          ],
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        ttl: {
          description: 'Time To Live (TTL) of the RRSet. If not set, the Zone\'s Default TTL is used. If set, and the RRSet being updated already has a TTL, the values must be the same.',
          type: ['integer', 'null'],
          minimum: 60,
          maximum: 2147483647,
        },
        records: {
          description: 'Records to add to the RRSet. Must not be empty and must only contain distinct record values.',
          minItems: 1,
          maxItems: 50,
          type: 'array',
          items: {
            title: 'Record',
            description: 'Record of a RRSet. The value is used to identify the record in an RRSet.',
            type: 'object',
            properties: {
              value: {
                description: 'Value of the record. For details about accepted values, see the DNS record types documentation.',
                type: 'string',
              },
              comment: {
                description: 'Comment of the record.',
                type: 'string',
              },
            },
            additionalProperties: false,
            required: ['value'],
          },
        },
      },
      additionalProperties: false,
      required: ['records'],
    },
  },
  change_zone_rrset_protection: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
      {
        name: 'rr_name',
        in: 'path',
        required: true,
        schema: {
          type: 'string',
        },
      },
      {
        name: 'rr_type',
        in: 'path',
        required: true,
        schema: {
          description: 'Type of the RRSet.',
          type: 'string',
          enum: [
            'A',
            'AAAA',
            'CAA',
            'CNAME',
            'DS',
            'HINFO',
            'HTTPS',
            'MX',
            'NS',
            'PTR',
            'RP',
            'SOA',
            'SRV',
            'SVCB',
            'TLSA',
            'TXT',
          ],
        },
      },
    ],
    body: {
      description: 'Protection of the RRSet.',
      type: 'object',
      properties: {
        change: {
          description: 'Prevent the Resource from being changed.',
          type: 'boolean',
        },
      },
      additionalProperties: false,
      required: ['change'],
    },
  },
  change_zone_rrset_ttl: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
      {
        name: 'rr_name',
        in: 'path',
        required: true,
        schema: {
          type: 'string',
        },
      },
      {
        name: 'rr_type',
        in: 'path',
        required: true,
        schema: {
          description: 'Type of the RRSet.',
          type: 'string',
          enum: [
            'A',
            'AAAA',
            'CAA',
            'CNAME',
            'DS',
            'HINFO',
            'HTTPS',
            'MX',
            'NS',
            'PTR',
            'RP',
            'SOA',
            'SRV',
            'SVCB',
            'TLSA',
            'TXT',
          ],
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        ttl: {
          description: 'Time To Live (TTL) of the RRSet. Must be in between 60s and 2147483647s. If not set, the Zone\'s Default TTL is used.',
          type: ['integer', 'null'],
          minimum: 60,
          maximum: 2147483647,
        },
      },
      additionalProperties: false,
      required: ['ttl'],
    },
  },
  remove_zone_rrset_records: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
      {
        name: 'rr_name',
        in: 'path',
        required: true,
        schema: {
          type: 'string',
        },
      },
      {
        name: 'rr_type',
        in: 'path',
        required: true,
        schema: {
          description: 'Type of the RRSet.',
          type: 'string',
          enum: [
            'A',
            'AAAA',
            'CAA',
            'CNAME',
            'DS',
            'HINFO',
            'HTTPS',
            'MX',
            'NS',
            'PTR',
            'RP',
            'SOA',
            'SRV',
            'SVCB',
            'TLSA',
            'TXT',
          ],
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        records: {
          description: 'Records to remove from the RRSet. Must not be empty and must only contain distinct record values.',
          minItems: 1,
          maxItems: 50,
          type: 'array',
          items: {
            title: 'Record',
            description: 'Record of a RRSet. The value is used to identify the record in an RRSet.',
            type: 'object',
            properties: {
              value: {
                description: 'Value of the record. For details about accepted values, see the DNS record types documentation.',
                type: 'string',
              },
              comment: {
                description: 'Comment of the record.',
                type: 'string',
              },
            },
            additionalProperties: false,
            required: ['value'],
          },
        },
      },
      additionalProperties: false,
      required: ['records'],
    },
  },
  set_zone_rrset_records: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
      {
        name: 'rr_name',
        in: 'path',
        required: true,
        schema: {
          type: 'string',
        },
      },
      {
        name: 'rr_type',
        in: 'path',
        required: true,
        schema: {
          description: 'Type of the RRSet.',
          type: 'string',
          enum: [
            'A',
            'AAAA',
            'CAA',
            'CNAME',
            'DS',
            'HINFO',
            'HTTPS',
            'MX',
            'NS',
            'PTR',
            'RP',
            'SOA',
            'SRV',
            'SVCB',
            'TLSA',
            'TXT',
          ],
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        records: {
          description: 'Records to set in the RRSet. Must not be empty and must only contain distinct record values.',
          minItems: 1,
          maxItems: 50,
          type: 'array',
          items: {
            title: 'Record',
            description: 'Record of a RRSet. The value is used to identify the record in an RRSet.',
            type: 'object',
            properties: {
              value: {
                description: 'Value of the record. For details about accepted values, see the DNS record types documentation.',
                type: 'string',
              },
              comment: {
                description: 'Comment of the record.',
                type: 'string',
              },
            },
            additionalProperties: false,
            required: ['value'],
          },
        },
      },
      additionalProperties: false,
      required: ['records'],
    },
  },
  update_zone_rrset_records: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
      {
        name: 'rr_name',
        in: 'path',
        required: true,
        schema: {
          type: 'string',
        },
      },
      {
        name: 'rr_type',
        in: 'path',
        required: true,
        schema: {
          description: 'Type of the RRSet.',
          type: 'string',
          enum: [
            'A',
            'AAAA',
            'CAA',
            'CNAME',
            'DS',
            'HINFO',
            'HTTPS',
            'MX',
            'NS',
            'PTR',
            'RP',
            'SOA',
            'SRV',
            'SVCB',
            'TLSA',
            'TXT',
          ],
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        records: {
          description: 'Records to update in the RRSet. Must not be empty and must only contain distinct record values.',
          minItems: 1,
          maxItems: 50,
          type: 'array',
          items: {
            title: 'Record',
            description: 'Record of a RRSet. The value is used to identify the record in an RRSet.',
            type: 'object',
            properties: {
              value: {
                description: 'Value of the record to update.',
                type: 'string',
              },
              comment: {
                description: 'New comment for the record.',
                type: 'string',
              },
            },
            additionalProperties: false,
            required: ['value', 'comment'],
          },
        },
      },
      additionalProperties: false,
      required: ['records'],
    },
  },
  get_zone_zonefile: {
    params: [
      {
        name: 'id_or_name',
        in: 'path',
        required: true,
        description: 'ID or Name of the Zone.',
        schema: {
          description: 'ID or Name of the Zone.',
          type: 'string',
        },
      },
    ],
  },
  list_zones_actions: {
    params: [
      {
        name: 'id',
        in: 'query',
        description: 'Filter the actions by ID. May be used multiple times. The response will only contain actions matching the specified IDs.',
        schema: {
          type: 'array',
          items: {
            description: 'ID of the Action.',
            type: 'integer',
            format: 'int64',
            minimum: 1,
            maximum: 9007199254740991,
          },
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_zones_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_storage_box_types: {
    params: [
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_storage_box_type: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box Type.',
        schema: {
          description: 'ID of the Storage Box Type.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_storage_boxes: {
    params: [
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'label_selector',
        in: 'query',
        description: 'Filter resources by labels. The response will only contain resources matching the label selector. For more information, see "Label Selector".',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort resources by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'name',
              'name:asc',
              'name:desc',
              'created',
              'created:asc',
              'created:desc',
              'stats.size',
              'stats.size:asc',
              'stats.size:desc',
              'stats.size_filesystem',
              'stats.size_filesystem:asc',
              'stats.size_filesystem:desc',
            ],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  create_storage_box: {
    body: {
      type: 'object',
      properties: {
        name: {
          description: 'Name of the Storage Box.',
          type: 'string',
        },
        location: {
          description: 'ID or Name of Location.',
          type: 'string',
        },
        storage_box_type: {
          description: 'ID or Name of the Storage Box Type.',
          type: 'string',
        },
        password: {
          description: 'Password of the Storage Box. For more details, see the Storage Boxes password policy.',
          type: 'string',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
        ssh_keys: {
          description: 'SSH public keys in OpenSSH format to inject into the Storage Box.',
          type: 'array',
          items: {
            type: 'string',
          },
        },
        access_settings: {
          required: [],
          description: 'Access settings of the Storage Box.',
          type: 'object',
          properties: {
            reachable_externally: {
              description: 'Whether access from outside the Hetzner network is allowed.',
              type: 'boolean',
            },
            samba_enabled: {
              description: 'Whether the Samba subsystem is enabled.',
              type: 'boolean',
            },
            ssh_enabled: {
              description: 'Whether the SSH subsystem is enabled.',
              type: 'boolean',
            },
            webdav_enabled: {
              description: 'Whether the WebDAV subsystem is enabled.',
              type: 'boolean',
            },
            zfs_enabled: {
              description: 'Whether the ZFS snapshot folder is visible.',
              type: 'boolean',
            },
          },
        },
      },
      required: ['storage_box_type', 'location', 'name', 'password'],
    },
  },
  get_storage_box: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  update_storage_box: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        name: {
          description: 'Name of the Storage Box.',
          type: 'string',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. Note that the set of Labels provided in the request will overwrite the existing one. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
    },
  },
  delete_storage_box: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_storage_box_actions: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_storage_box_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'action_id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  change_storage_box_protection: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      description: 'Protection configuration for the Resource.',
      type: 'object',
      properties: {
        delete: {
          description: 'Prevent the Resource from being deleted.',
          type: 'boolean',
        },
      },
    },
  },
  change_storage_box_type: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        storage_box_type: {
          description: 'ID or Name of the Storage Box Type.',
          type: 'string',
        },
      },
      required: ['storage_box_type'],
    },
  },
  disable_storage_box_snapshot_plan: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  enable_storage_box_snapshot_plan: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        max_snapshots: {
          description: 'Maximum amount of Snapshots that will be created by this Snapshot Plan. Older Snapshots will be deleted.',
          type: 'integer',
          minimum: 1,
        },
        minute: {
          description: 'Minute when the Snapshot Plan is executed (UTC).',
          type: 'integer',
          minimum: 0,
          maximum: 59,
        },
        hour: {
          description: 'Hour when the Snapshot Plan is executed (UTC).',
          type: 'integer',
          minimum: 0,
          maximum: 23,
        },
        day_of_week: {
          description: 'Day of the week when the Snapshot Plan is executed. Starts at 1 for Monday til 7 for Sunday. Null means every day.',
          type: ['integer', 'null'],
          default: null,
          minimum: 1,
          maximum: 7,
        },
        day_of_month: {
          description: 'Day of the month when the Snapshot Plan is executed. Null means every day.',
          type: ['integer', 'null'],
          default: null,
          minimum: 1,
          maximum: 31,
        },
      },
      required: ['max_snapshots', 'minute', 'hour'],
    },
  },
  reset_storage_box_password: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        password: {
          description: 'Password of the Storage Box. For more details, see the Storage Boxes password policy.',
          type: 'string',
        },
      },
      required: ['password'],
    },
  },
  rollback_storage_box_snapshot: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        snapshot: {
          description: 'ID or Name of the Storage Box Snapshot.',
          type: 'string',
        },
      },
      required: ['snapshot'],
    },
  },
  update_storage_box_access_settings: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        reachable_externally: {
          description: 'Whether access from outside the Hetzner network is allowed.',
          type: 'boolean',
        },
        samba_enabled: {
          description: 'Whether the Samba subsystem is enabled.',
          type: 'boolean',
        },
        ssh_enabled: {
          description: 'Whether the SSH subsystem is enabled.',
          type: 'boolean',
        },
        webdav_enabled: {
          description: 'Whether the WebDAV subsystem is enabled.',
          type: 'boolean',
        },
        zfs_enabled: {
          description: 'Whether the ZFS snapshot folder is visible.',
          type: 'boolean',
        },
      },
    },
  },
  list_storage_box_folders: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'path',
        in: 'query',
        description: 'Relative path for which the listing is to be made.',
        schema: {
          type: 'string',
          default: '.',
        },
      },
    ],
  },
  list_storage_box_snapshots: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'label_selector',
        in: 'query',
        description: 'Filter resources by labels. The response will only contain resources matching the label selector. For more information, see "Label Selector".',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort resources by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'name',
              'name:asc',
              'name:desc',
              'created',
              'created:asc',
              'created:desc',
            ],
          },
        },
      },
      {
        name: 'is_automatic',
        in: 'query',
        description: 'Filter wether a Storage Box Snapshot is automatic.',
        schema: {
          type: 'boolean',
        },
      },
    ],
  },
  create_storage_box_snapshot: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        description: {
          description: 'Description of the Storage Box Snapshot.',
          type: 'string',
          maxLength: 1000,
          pattern: '[a-zA-Z0-9-_,:<>+#!\\(\\)\\[\\]\\{\\} ]*',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
    },
  },
  get_storage_box_snapshot: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'snapshot_id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box Snapshot.',
        schema: {
          description: 'ID of the Storage Box Snapshot.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  update_storage_box_snapshot: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'snapshot_id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box Snapshot.',
        schema: {
          description: 'ID of the Storage Box Snapshot.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        description: {
          description: 'Description of the Storage Box Snapshot.',
          type: 'string',
          maxLength: 1000,
          pattern: '[a-zA-Z0-9-_,:<>+#!\\(\\)\\[\\]\\{\\} ]*',
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. Note that the set of Labels provided in the request will overwrite the existing one. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
    },
  },
  delete_storage_box_snapshot: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'snapshot_id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box Snapshot.',
        schema: {
          description: 'ID of the Storage Box Snapshot.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  list_storage_box_subaccounts: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'name',
        in: 'query',
        description: 'Filter resources by their name. The response will only contain the resources matching exactly the specified name.',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'label_selector',
        in: 'query',
        description: 'Filter resources by labels. The response will only contain resources matching the label selector. For more information, see "Label Selector".',
        schema: {
          type: 'string',
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort resources by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'created',
              'created:asc',
              'created:desc',
            ],
          },
        },
      },
      {
        name: 'username',
        in: 'query',
        description: 'Filter Storage Box Subaccounts by username. The response will only contain the resources matching exactly the specified username.',
        schema: {
          type: 'string',
        },
      },
    ],
  },
  create_storage_box_subaccount: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        home_directory: {
          description: 'Home directory of the Storage Box Subaccount. The directory will be created if it doesn\'t exist yet.',
          type: 'string',
          minLength: 1,
          maxLength: 999,
          pattern: '^[a-zA-Z0-9 ./_-]+$',
        },
        password: {
          description: 'Password of the Storage Box Subaccount. For more details, see the Storage Boxes password policy.',
          type: 'string',
        },
        access_settings: {
          type: 'object',
          properties: {
            reachable_externally: {
              description: 'Whether access from outside the Hetzner network is allowed.',
              type: 'boolean',
            },
            samba_enabled: {
              description: 'Whether the Samba subsystem is enabled.',
              type: 'boolean',
            },
            ssh_enabled: {
              description: 'Whether the SSH subsystem is enabled.',
              type: 'boolean',
            },
            webdav_enabled: {
              description: 'Whether the WebDAV subsystem is enabled.',
              type: 'boolean',
            },
            readonly: {
              description: 'Whether the Subaccount is read-only.',
              type: 'boolean',
            },
          },
        },
        name: {
          description: 'Name of the Storage Box Subaccount. Defaults to the Storage Box Subaccount username.',
          type: 'string',
          minLength: 1,
          maxLength: 50,
        },
        description: {
          description: 'A description of Storage Box Subaccount.',
          type: 'string',
          maxLength: 1000,
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
      required: ['home_directory', 'password'],
    },
  },
  get_storage_box_subaccount: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'subaccount_id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box Subaccount.',
        schema: {
          description: 'ID of the Storage Box Subaccount.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  update_storage_box_subaccount: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'subaccount_id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box Subaccount.',
        schema: {
          description: 'ID of the Storage Box Subaccount.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        name: {
          description: 'Name of the Storage Box Subaccount.',
          type: 'string',
          minLength: 1,
          maxLength: 50,
        },
        description: {
          description: 'A description of Storage Box Subaccount.',
          type: 'string',
          maxLength: 1000,
        },
        labels: {
          description: 'User-defined labels (key/value pairs) for the Resource. Note that the set of Labels provided in the request will overwrite the existing one. For more information, see "Labels".',
          type: 'object',
          additionalProperties: {
            type: 'string',
          },
        },
      },
    },
  },
  delete_storage_box_subaccount: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'subaccount_id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box Subaccount.',
        schema: {
          description: 'ID of the Storage Box Subaccount.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
  change_storage_box_subaccount_home_directory: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'subaccount_id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box Subaccount.',
        schema: {
          description: 'ID of the Storage Box Subaccount.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        home_directory: {
          description: 'Home directory of the Storage Box Subaccount. The directory will be created if it doesn\'t exist yet.',
          type: 'string',
          minLength: 1,
          maxLength: 999,
          pattern: '^[a-zA-Z0-9 ./_-]+$',
        },
      },
      required: ['home_directory'],
    },
  },
  reset_storage_box_subaccount_password: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'subaccount_id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box Subaccount.',
        schema: {
          description: 'ID of the Storage Box Subaccount.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        password: {
          description: 'Password of the Storage Box Subaccount. For more details, see the Storage Boxes password policy.',
          type: 'string',
        },
      },
      required: ['password'],
    },
  },
  update_storage_box_subaccount_access_settings: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box.',
        schema: {
          description: 'ID of the Storage Box.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
      {
        name: 'subaccount_id',
        in: 'path',
        required: true,
        description: 'ID of the Storage Box Subaccount.',
        schema: {
          description: 'ID of the Storage Box Subaccount.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
    body: {
      type: 'object',
      properties: {
        readonly: {
          description: 'Whether the Subaccount is read-only.',
          type: 'boolean',
        },
        reachable_externally: {
          description: 'Whether access from outside the Hetzner network is allowed.',
          type: 'boolean',
        },
        samba_enabled: {
          description: 'Whether the Samba subsystem is enabled.',
          type: 'boolean',
        },
        ssh_enabled: {
          description: 'Whether the SSH subsystem is enabled.',
          type: 'boolean',
        },
        webdav_enabled: {
          description: 'Whether the WebDAV subsystem is enabled.',
          type: 'boolean',
        },
      },
    },
  },
  list_storage_boxes_actions: {
    params: [
      {
        name: 'id',
        in: 'query',
        description: 'Filter the actions by ID. May be used multiple times. The response will only contain actions matching the specified IDs.',
        schema: {
          type: 'array',
          items: {
            description: 'ID of the Action.',
            type: 'integer',
            format: 'int64',
            minimum: 1,
            maximum: 9007199254740991,
          },
        },
      },
      {
        name: 'sort',
        in: 'query',
        description: 'Sort actions by field and direction. May be used multiple times. For more information, see "Sorting".',
        schema: {
          type: 'array',
          items: {
            type: 'string',
            enum: [
              'id',
              'id:asc',
              'id:desc',
              'command',
              'command:asc',
              'command:desc',
              'status',
              'status:asc',
              'status:desc',
              'started',
              'started:asc',
              'started:desc',
              'finished',
              'finished:asc',
              'finished:desc',
            ],
          },
        },
      },
      {
        name: 'status',
        in: 'query',
        description: 'Filter the actions by status. May be used multiple times. The response will only contain actions matching the specified statuses.',
        schema: {
          type: 'array',
          items: {
            description: 'Status of the Action.',
            type: 'string',
            enum: ['running', 'success', 'error'],
          },
        },
      },
      {
        name: 'page',
        in: 'query',
        description: 'Page number to return. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 1,
        },
      },
      {
        name: 'per_page',
        in: 'query',
        description: 'Maximum number of entries returned per page. For more information, see "Pagination".',
        schema: {
          type: 'integer',
          format: 'int64',
          default: 25,
        },
      },
    ],
  },
  get_storage_boxes_action: {
    params: [
      {
        name: 'id',
        in: 'path',
        required: true,
        description: 'ID of the Action.',
        schema: {
          description: 'ID of the Action.',
          type: 'integer',
          format: 'int64',
          minimum: 1,
          maximum: 9007199254740991,
        },
      },
    ],
  },
};
