import type {
  HostAdapter,
  HostAttachmentItem,
  TableRecordRow,
  TableRecordUpdate,
  TableSchema,
  TableSummary,
  UserIdentity,
  ValidatedRow,
} from '@table-ai/core';

export const DEMO_SCHEMAS: Record<string, TableSchema> = {
  quote: {
    tableId: 'demo_quote',
    tableName: '供应商采购报价单',
    attachmentFields: [{ id: 'f_att_quote', name: '原始报价单附件' }],
    fields: [
      { id: 'f_vendor', name: '供应商名称', type: 'text' },
      { id: 'f_item', name: '商品名称', type: 'text' },
      { id: 'f_qty', name: '数量', type: 'number' },
      { id: 'f_price', name: '单价', type: 'number' },
      { id: 'f_total', name: '金额合计', type: 'number' },
      { id: 'f_date', name: '报价日期', type: 'date' },
      {
        id: 'f_status',
        name: '状态',
        type: 'singleSelect',
        options: [
          { id: 'opt_1', name: '待比价' },
          { id: 'opt_2', name: '已确认' },
          { id: 'opt_3', name: '已作废' },
        ],
      },
    ],
    sampleRows: [
      {
        供应商名称: '杭州星辰供应链有限公司',
        商品名称: '定制礼盒外箱 30*20cm',
        数量: 500,
        单价: 4.5,
        金额合计: 2250,
        报价日期: '2026-11-18',
        状态: '待比价',
      },
    ],
  },
  erp_bill: {
    tableId: 'demo_erp_bill',
    tableName: '财务 ERP 对账结算单（对照表）',
    fields: [
      { id: 'e_vendor', name: '商户名称', type: 'text' },
      { id: 'e_item', name: '品名', type: 'text' },
      { id: 'e_qty', name: '采购件数', type: 'number' },
      { id: 'e_total', name: '实付总额', type: 'number' },
      { id: 'e_date', name: '入账日期', type: 'date' },
    ],
    sampleRows: [],
  },
  resume: {
    tableId: 'demo_resume',
    tableName: 'HR 候选人简历初筛表',
    attachmentFields: [{ id: 'f_att_resume', name: '候选人简历 PDF' }],
    fields: [
      { id: 'f_name', name: '候选人姓名', type: 'text' },
      { id: 'f_phone', name: '手机号', type: 'phone' },
      { id: 'f_exp', name: '工作年限', type: 'number' },
      { id: 'f_role', name: '应聘岗位', type: 'text' },
      {
        id: 'f_edu',
        name: '最高学历',
        type: 'singleSelect',
        options: [
          { id: 'edu_1', name: '大专' },
          { id: 'edu_2', name: '本科' },
          { id: 'edu_3', name: '硕士' },
          { id: 'edu_4', name: '博士' },
        ],
      },
      {
        id: 'f_tags',
        name: '核心技能',
        type: 'multiSelect',
        options: [
          { id: 't_1', name: 'React' },
          { id: 't_2', name: 'TypeScript' },
          { id: 't_3', name: 'Node.js' },
          { id: 't_4', name: 'Python' },
          { id: 't_5', name: 'AI应用' },
        ],
      },
    ],
    sampleRows: [
      {
        候选人姓名: '张三',
        手机号: '13900001111',
        工作年限: 5,
        应聘岗位: '资深前端工程师',
        最高学历: '本科',
        核心技能: ['React', 'TypeScript'],
      },
    ],
  },
  expense: {
    tableId: 'demo_expense',
    tableName: '日常票据与转账台账',
    attachmentFields: [{ id: 'f_att_expense', name: '票据与微信截图' }],
    fields: [
      { id: 'f_merchant', name: '收款方/商户', type: 'text' },
      { id: 'f_date', name: '消费日期', type: 'date' },
      { id: 'f_amount', name: '实付金额', type: 'number' },
      {
        id: 'f_cat',
        name: '费用类别',
        type: 'singleSelect',
        options: [
          { id: 'c_1', name: '差旅交通' },
          { id: 'c_2', name: '餐饮招待' },
          { id: 'c_3', name: '办公采购' },
          { id: 'c_4', name: '云服务/软件' },
        ],
      },
      { id: 'f_remark', name: '备注', type: 'text' },
    ],
    sampleRows: [],
  },
};

function initialDemoRecords(): Record<string, TableRecordRow[]> {
  return {
    demo_quote: [
      {
        recordId: 'rec_q_1',
        values: {
          f_vendor: '  杭州星辰供应链有限公司（已签合同） ',
          f_item: '定制礼盒外箱 30*20cm',
          f_qty: 500,
          f_price: 4.5,
          f_total: 2250,
          f_date: '2026/11/8',
          f_status: '已确认',
        },
      },
      {
        recordId: 'rec_q_2',
        values: {
          f_vendor: '星辰包装\u200B（老王报价）',
          f_item: '加厚防震气泡袋 M号',
          f_qty: 1000,
          f_price: 0.85,
          f_total: 850,
          f_date: '2026年11月12日',
          f_status: '待比价',
        },
      },
      {
        recordId: 'rec_q_3',
        values: {
          f_vendor: '义乌顺达印刷厂  ',
          f_item: '定制不干胶标签 ５０００张',
          f_qty: 5000,
          f_price: 0.12,
          f_total: 600,
          f_date: '2026.11.19',
          f_status: '已确认',
        },
      },
      {
        recordId: 'rec_q_4',
        values: {
          f_vendor: '深圳华强电子配件(急单)',
          f_item: 'Type-C 快充数据线 1.5m',
          f_qty: 200,
          f_price: 6.5,
          f_total: 1300,
          f_date: '2026-11-24',
          f_status: '待比价',
        },
      },
    ],
    demo_erp_bill: [
      {
        recordId: 'rec_e_1',
        values: {
          e_vendor: '杭州星辰供应链有限公司',
          e_item: '定制礼盒外箱 30*20cm',
          e_qty: 500,
          e_total: 2250,
          e_date: '2026-11-08',
        },
      },
      {
        recordId: 'rec_e_2',
        values: {
          e_vendor: '星辰包装',
          e_item: '加厚防震气泡袋 M号',
          e_qty: 1000,
          e_total: 880, // Intentional +30 diff vs quote (850)
          e_date: '2026-11-12',
        },
      },
      {
        recordId: 'rec_e_3',
        values: {
          e_vendor: '义乌顺达印刷厂',
          e_item: '定制不干胶标签 5000张',
          e_qty: 5000,
          e_total: 600,
          e_date: '2026-11-19',
        },
      },
      {
        recordId: 'rec_e_5',
        values: {
          e_vendor: '顺丰速运',
          e_item: '11月样品寄送月结运费',
          e_qty: 1,
          e_total: 320,
          e_date: '2026-11-25',
        },
      },
    ],
    demo_resume: [
      {
        recordId: 'rec_r_1',
        values: {
          f_name: '林晓明（内推）',
          f_phone: '联系：138-6677-8899 杭州',
          f_exp: 6,
          f_role: '资深前端工程师',
          f_edu: '硕士',
          f_tags: ['React', 'TypeScript', 'AI应用'],
        },
      },
      {
        recordId: 'rec_r_2',
        values: {
          f_name: '  陈思远 ',
          f_phone: '１３９００１３９０００',
          f_exp: 4,
          f_role: '全栈研发工程师',
          f_edu: '本科',
          f_tags: ['Node.js', 'TypeScript'],
        },
      },
    ],
    demo_expense: [
      {
        recordId: 'rec_x_1',
        values: {
          f_merchant: '滴滴出行科技有限公司 ',
          f_date: '2026/11/22',
          f_amount: 148.6,
          f_cat: '差旅交通',
          f_remark: '杭州东站客户拜访往返',
        },
      },
      {
        recordId: 'rec_x_2',
        values: {
          f_merchant: '火山引擎（云计算）',
          f_date: '2026年11月25日',
          f_amount: 200,
          f_cat: '云服务/软件',
          f_remark: 'Doubao Seed API 充值',
        },
      },
    ],
  };
}

function createDemoDocumentImage(fileName: string, lines: string[]): Promise<File> {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 460;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = '#d9dce3';
      ctx.lineWidth = 2;
      ctx.strokeRect(20, 20, canvas.width - 40, canvas.height - 40);
      ctx.fillStyle = '#1f2329';
      ctx.font = 'bold 26px sans-serif';
      ctx.fillText(lines[0] || fileName, 48, 76);
      ctx.font = '20px sans-serif';
      ctx.fillStyle = '#333b48';
      lines.slice(1).forEach((line, idx) => {
        ctx.fillText(line, 48, 130 + idx * 42);
      });
    }
    canvas.toBlob(
      (blob) => {
        const file = new File([blob || new Blob(['demo'])], fileName, { type: 'image/jpeg' });
        resolve(file);
      },
      'image/jpeg',
      0.92
    );
  });
}

export class MockHostAdapter implements HostAdapter {
  readonly hostName = '本地浏览器模拟模式（脱离飞书可直接演示）';
  private activeKey: keyof typeof DEMO_SCHEMAS = 'quote';
  private recordsByTable: Record<string, TableRecordRow[]> = initialDemoRecords();
  public writtenHistory: ValidatedRow[] = [];

  setDemoSchema(key: keyof typeof DEMO_SCHEMAS) {
    this.activeKey = key;
  }

  getDemoKey() {
    return this.activeKey;
  }

  async getUserIdentity(): Promise<UserIdentity> {
    const key = 'any_to_sheet_mock_uid';
    let uid = window.localStorage.getItem(key);
    if (!uid) {
      uid = `mock_${Math.random().toString(36).slice(2, 10)}`;
      window.localStorage.setItem(key, uid);
    }
    return { userId: uid, tenantKey: 'mock_tenant' };
  }

  async getActiveTableSchema(preferredTableId?: string): Promise<TableSchema> {
    if (preferredTableId) {
      const found = Object.values(DEMO_SCHEMAS).find((s) => s.tableId === preferredTableId);
      if (found) return found;
    }
    return DEMO_SCHEMAS[this.activeKey];
  }

  async listTables(): Promise<TableSummary[]> {
    return Object.values(DEMO_SCHEMAS).map((s) => ({
      tableId: s.tableId,
      tableName: s.tableName,
    }));
  }

  async readTableRecords(
    tableId?: string,
    limit = 500
  ): Promise<{
    schema: TableSchema;
    records: TableRecordRow[];
    totalCount: number;
    truncated: boolean;
  }> {
    const schema = await this.getActiveTableSchema(tableId);
    const list = this.recordsByTable[schema.tableId] || [];
    const sliced = list.slice(0, limit).map((r) => ({
      recordId: r.recordId,
      values: { ...r.values },
      rawValues: { ...r.values },
    }));
    return {
      schema,
      records: sliced,
      totalCount: list.length,
      truncated: list.length > sliced.length,
    };
  }

  async updateTableRecords(
    schema: TableSchema,
    updates: TableRecordUpdate[]
  ): Promise<{ updatedCount: number }> {
    const list = this.recordsByTable[schema.tableId] || [];
    let updatedCount = 0;
    for (const u of updates) {
      const target = list.find((r) => r.recordId === u.recordId);
      if (target) {
        Object.assign(target.values, u.values);
        updatedCount++;
      }
    }
    return { updatedCount };
  }

  async readAttachmentsFromField(_fieldId: string): Promise<HostAttachmentItem[]> {
    if (this.activeKey === 'resume') {
      const f1 = await createDemoDocumentImage('林晓明_前端开发简历.jpg', [
        '个人简历 - 林晓明',
        '手机：13866778899 ｜ 学历：硕士（浙江大学）',
        '工作年限：6年 ｜ 应聘岗位：AI 应用前端负责人',
        '核心技能：React, TypeScript, Node.js, AI应用',
      ]);
      return [
        {
          id: 'mock_att_r1',
          recordId: 'rec_mock_1',
          fileName: f1.name,
          mimeType: f1.type,
          size: f1.size,
          file: f1,
        },
      ];
    }

    if (this.activeKey === 'expense') {
      const f1 = await createDemoDocumentImage('滴滴电子行程单_11月.jpg', [
        '电子发票 / 行程报销凭证',
        '商户：滴滴出行科技有限公司 ｜ 日期：2026-11-22',
        '实付金额：¥148.60 ｜ 类别：差旅交通',
        '备注：杭州东站至客户拜访往返',
      ]);
      return [
        {
          id: 'mock_att_e1',
          recordId: 'rec_mock_1',
          fileName: f1.name,
          mimeType: f1.type,
          size: f1.size,
          file: f1,
        },
      ];
    }

    const f1 = await createDemoDocumentImage('星辰包装_11月采购报价单.jpg', [
      '杭州星辰包装有限公司 - 报价单（日期：2026-11-24）',
      '明细 1：定制飞机盒 M号 ｜ 数量：1000 ｜ 单价：3.2元 ｜ 合计：3200元',
      '明细 2：加厚气泡袋 20*30cm ｜ 数量：500 ｜ 单价：0.8元 ｜ 合计：400元',
      '状态：待比价',
    ]);
    return [
      {
        id: 'mock_att_q1',
        recordId: 'rec_mock_1',
        fileName: f1.name,
        mimeType: f1.type,
        size: f1.size,
        file: f1,
      },
    ];
  }

  async writeValidatedRows(
    schema: TableSchema,
    rows: ValidatedRow[]
  ): Promise<{ writtenCount: number }> {
    this.writtenHistory.push(...rows);
    const list = this.recordsByTable[schema.tableId] || [];
    rows.forEach((row, idx) => {
      const values: Record<string, unknown> = {};
      for (const [fid, cell] of Object.entries(row.cells)) {
        values[fid] = cell.value;
      }
      list.push({
        recordId: `rec_new_${Date.now()}_${idx}`,
        values,
      });
    });
    this.recordsByTable[schema.tableId] = list;
    return { writtenCount: rows.length };
  }
}
