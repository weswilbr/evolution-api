import { WAMonitoringService } from '@api/services/monitor.service';
import { Events } from '@api/types/wa.types';
import { ConfigService, Typesafe } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { getConversationMessage } from '@utils/getConversationMessage';
import axios from 'axios';

import { EmitData } from '../../chatbot.controller';

export type IntentClassification = {
  remoteJid: string;
  pushName?: string;
  messageId?: string;
  text: string;
  intent: string;
  confidence: number;
  probabilities: Record<string, number>;
  needsReview: boolean;
  label?: string;
  model: string;
};

// Used when TYPESAFE_INTENTS is not set. The last option is the no-match outcome.
const DEFAULT_INTENTS: Record<string, string> = {
  buy: 'Wants to buy, asks for the price, how to order, payment methods or delivery of a product',
  product_question: 'Asks how a product works, its ingredients, how to use it or who can use it',
  partnership: 'Wants to become a reseller, affiliate, distributor or business partner',
  support: 'Has a problem with an existing order, payment, delivery or account',
  other: 'Greeting, small talk, or a subject that does not fit the other options',
};

export class TypesafeService {
  private readonly logger = new Logger('TypesafeService');

  constructor(
    private readonly waMonitor: WAMonitoringService,
    private readonly configService: ConfigService,
  ) {}

  private get config(): Typesafe {
    return this.configService.get<Typesafe>('TYPESAFE');
  }

  private parseMap(raw: string, name: string): Record<string, string> | null {
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length > 0) {
        return parsed;
      }
    } catch {
      // falls through to the warning below
    }

    this.logger.warn(`${name} must be a non-empty JSON object; ignoring it`);
    return null;
  }

  private get intents(): Record<string, string> {
    return this.parseMap(this.config.INTENTS, 'TYPESAFE_INTENTS') || DEFAULT_INTENTS;
  }

  public async classify(
    text: string,
  ): Promise<{ intent: string; confidence: number; probabilities: Record<string, number> }> {
    const { API_URL, API_KEY, MODEL } = this.config;

    const { data } = await axios.post(
      `${API_URL}/v1/systemone`,
      {
        model: MODEL,
        state: { message: text },
        questions: {
          intent: {
            type: 'choice',
            instructions: 'What does the customer who sent `message` on WhatsApp want?',
            criteria: this.intents,
          },
        },
      },
      {
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      },
    );

    const answer = data?.answers?.intent;
    if (!answer?.choice) {
      throw new Error('TypeSafe response without an intent answer');
    }

    return { intent: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities };
  }

  private async applyLabel(instance: any, instanceName: string, remoteJid: string, labelName: string) {
    if (typeof instance.fetchLabels !== 'function' || typeof instance.handleLabel !== 'function') return null;

    const labels = await instance.fetchLabels();
    const label = labels.find((l: { name: string }) => l.name?.trim().toLowerCase() === labelName.trim().toLowerCase());
    if (!label) {
      this.logger.warn(`Label "${labelName}" not found in instance ${instanceName}`);
      return null;
    }

    await instance.handleLabel({ number: remoteJid.split('@')[0], labelId: label.id, action: 'add' });
    return label.name;
  }

  public async emit({ instance, remoteJid, msg, pushName }: EmitData) {
    const config = this.config;
    if (!config?.ENABLED || !config.API_KEY) return;

    try {
      if (!remoteJid || msg?.key?.fromMe || remoteJid === 'status@broadcast') return;
      if (config.IGNORE_GROUPS && remoteJid.endsWith('@g.us')) return;

      const text = getConversationMessage(msg);
      if (typeof text !== 'string' || !text.trim()) return;

      const waInstance = this.waMonitor.waInstances[instance.instanceName];
      if (!waInstance) return;

      const result = await this.classify(text.trim());
      const needsReview = result.confidence < config.MIN_CONFIDENCE;

      let label: string;
      const labels = this.parseMap(config.LABELS, 'TYPESAFE_LABELS');
      if (config.APPLY_LABELS && !needsReview && labels?.[result.intent]) {
        try {
          label = await this.applyLabel(waInstance, instance.instanceName, remoteJid, labels[result.intent]);
        } catch (error) {
          this.logger.error(`Error applying label: ${error?.message || error}`);
        }
      }

      const classification: IntentClassification = {
        remoteJid,
        pushName,
        messageId: msg?.key?.id,
        text: text.trim(),
        intent: result.intent,
        confidence: result.confidence,
        probabilities: result.probabilities,
        needsReview,
        label,
        model: config.MODEL,
      };

      this.logger.log(
        `Message ${classification.messageId} from ${remoteJid} classified as ${result.intent} (${result.confidence})`,
      );

      waInstance.sendDataWebhook(Events.MESSAGES_CLASSIFIED, classification);
    } catch (error) {
      this.logger.error(`Error classifying message: ${error?.response?.status || ''} ${error?.message || error}`);
    }
  }
}
