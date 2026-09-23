// Мок expo-device для юнит-тестов (testEnvironment: 'node').
// Реальный пакет — ESM и тянет нативный модуль; тестам нужны только поля бренда,
// а логика, которая их читает, принимает окружение параметром.
export const brand: string | null = null;
export const manufacturer: string | null = null;
export const modelName: string | null = null;
export const osName: string | null = null;
export const osVersion: string | null = null;
export const isDevice = true;
