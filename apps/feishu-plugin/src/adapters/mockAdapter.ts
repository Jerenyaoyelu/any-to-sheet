import type { HostAdapter, HostAttachmentItem, TableSchema, ValidatedRow } from '@table-ai/core';

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
  public writtenHistory: ValidatedRow[] = [];

  setDemoSchema(key: keyof typeof DEMO_SCHEMAS) {
    this.activeKey = key;
  }

  getDemoKey() {
    return this.activeKey;
  }

  async getActiveTableSchema(): Promise<TableSchema> {
    return DEMO_SCHEMAS[this.activeKey];
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
    _schema: TableSchema,
    rows: ValidatedRow[]
  ): Promise<{ writtenCount: number }> {
    this.writtenHistory.push(...rows);
    return { writtenCount: rows.length };
  }
}
