// Выбор тем ленты Fliq: при первом открытии и по кнопке в шапке.
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { AppDialogModal } from '../../components/AppDialog';
import type { Lang } from '../../utils/i18n';
import { UI_ACCENT, UI_INACTIVE, UI_RIM, WELCOME_FILTER_ACTIVE, WELCOME_HEADER_TITLE } from '../home/constants';
import { FLIQ_TOPICS, type FliqTopic } from './fliqTopics';
import { fliqT } from './fliqI18n';

const TOPIC_ICON: Record<FliqTopic, React.ComponentProps<typeof MaterialCommunityIcons>['name']> = {
  humor: 'emoticon-lol-outline',
  animals: 'paw',
  music: 'music-note',
  sport: 'soccer',
  games: 'gamepad-variant-outline',
  food: 'silverware-fork-knife',
  science: 'flask-outline',
  travel: 'airplane',
  cars: 'car-sports',
  art: 'palette-outline',
  technology: 'laptop',
  politics: 'bank-outline',
  history: 'castle',
  fishing: 'fish',
  hunting: 'bow-arrow',
  fitness: 'dumbbell',
  fashion: 'hanger',
  movies: 'movie-open-outline',
  business: 'chart-line',
  nature: 'pine-tree',
};

/** Выбранная тема — как кнопка «Найти собеседника»: мягкая заливка акцентом и чёткая рамка. */
const CHIP_SELECTED_BORDER = 'rgba(98, 176, 216, 0.58)';

type Props = {
  visible: boolean;
  lang: Lang;
  initial: FliqTopic[];
  onDone: (topics: FliqTopic[]) => void;
};

export function FliqTopicsDialog({ visible, lang, initial, onDone }: Props) {
  const [picked, setPicked] = useState<Set<FliqTopic>>(() => new Set(initial));
  useEffect(() => {
    if (visible) setPicked(new Set(initial));
  }, [visible, initial]);

  const toggle = (topic: FliqTopic) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(topic)) next.delete(topic);
      else next.add(topic);
      return next;
    });

  // «Назад» и тап мимо — как «Все темы»: лента не должна ждать выбора.
  const chooseAll = () => onDone([]);
  const done = () => onDone(FLIQ_TOPICS.filter((t) => picked.has(t)));

  return (
    <AppDialogModal
      visible={visible}
      onRequestClose={() => onDone(FLIQ_TOPICS.filter((t) => picked.has(t)))}
      title={fliqT('topicsTitle', lang)}
      message={fliqT('topicsHint', lang)}
      actions={[
        { label: fliqT('topicsAll', lang), onPress: chooseAll },
        { label: fliqT('topicsDone', lang), onPress: done, variant: 'primary', disabled: picked.size === 0 },
      ]}
    >
      <View style={styles.grid} accessibilityLabel={fliqT('topicsA11y', lang)}>
        {FLIQ_TOPICS.map((topic) => {
          const on = picked.has(topic);
          return (
            <Pressable
              key={topic}
              onPress={() => toggle(topic)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              style={({ pressed }) => [
                styles.chip,
                on && styles.chipOn,
                pressed && styles.chipPressed,
              ]}
            >
              <MaterialCommunityIcons name={TOPIC_ICON[topic]} size={17} color={on ? UI_ACCENT : UI_INACTIVE} />
              <Text style={[styles.chipLabel, on && styles.chipLabelOn]} numberOfLines={1}>
                {fliqT(`topic_${topic}`, lang)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </AppDialogModal>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 4,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 36,
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: UI_RIM,
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  chipOn: {
    backgroundColor: WELCOME_FILTER_ACTIVE,
    borderColor: CHIP_SELECTED_BORDER,
  },
  chipPressed: { transform: [{ scale: 0.97 }] },
  chipLabel: { color: UI_INACTIVE, fontSize: 14 },
  chipLabelOn: { color: WELCOME_HEADER_TITLE },
});
