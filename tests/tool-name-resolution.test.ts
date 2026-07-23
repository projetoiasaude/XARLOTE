import { describe, it, expect } from 'vitest';
import { resolveToolName } from '../packages/llm/src/client.js';

// Blinda a resiliência a TYPO de tool do modelo (incidente Vadivino 22/07: o LLM chamou
// `request_cllarification` com L dobrado → "tool desconhecida" → chamada engolida em silêncio →
// relay ao paciente nunca saía). O client resolve o nome cru pro tool VÁLIDO mais próximo.
const CLINIC = ['record_clinic_ack', 'record_clinic_unavailable', 'record_consultation_quote', 'request_clarification', 'finalize_clinic_contact', 'record_appointment_confirmation'];
const XARLOTE = ['start_pharmacy_order', 'message_supplier', 'confirm_order_selection', 'relay_answer_to_establishment', 'contact_establishment', 'nudge_consultation', 'start_consultation_search', 'cancel_consultation', 'find_clinic_by_name'];

describe('resolveToolName — resiliência a typo de tool', () => {
  it('corrige o typo EXATO do incidente (request_cllarification → request_clarification)', () => {
    expect(resolveToolName('request_cllarification', CLINIC)).toBe('request_clarification');
  });

  it('match exato passa direto (sem tocar)', () => {
    expect(resolveToolName('record_consultation_quote', CLINIC)).toBe('record_consultation_quote');
    expect(resolveToolName('nudge_consultation', XARLOTE)).toBe('nudge_consultation');
  });

  it('resolve case-insensitive', () => {
    expect(resolveToolName('Request_Clarification', CLINIC)).toBe('request_clarification');
  });

  it('corrige typos comuns (letra faltando/trocada) sem ambiguidade', () => {
    expect(resolveToolName('reqest_clarification', CLINIC)).toBe('request_clarification');
    expect(resolveToolName('record_clinic_unavailble', CLINIC)).toBe('record_clinic_unavailable');
    expect(resolveToolName('nudge_consultaton', XARLOTE)).toBe('nudge_consultation');
  });

  it('NÃO inventa quando o nome está longe de tudo (devolve o cru → o handler loga desconhecida)', () => {
    expect(resolveToolName('faz_um_cafe', CLINIC)).toBe('faz_um_cafe');
    expect(resolveToolName('', CLINIC)).toBe('');
    expect(resolveToolName('record_consultation_quote', [])).toBe('record_consultation_quote');
  });

  it('NÃO confunde tools distintas (typo perto de UMA só resolve pra ela)', () => {
    expect(resolveToolName('message_supplier', XARLOTE)).toBe('message_supplier');
    // typo de cancel_consultation NÃO pode virar start_consultation_search
    expect(resolveToolName('cancel_consultaton', XARLOTE)).toBe('cancel_consultation');
  });
});
